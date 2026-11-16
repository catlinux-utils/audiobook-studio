import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type ChunkQa,
  type CleanupOptions,
  type ExpertOptions,
  type ExpertRunResult,
  type VoiceAnalysis,
  type VoiceDetail,
  type VoiceTake,
} from '../lib/api';
import { EXPERT_OPTIONS, type ExpertOptionDef } from '../lib/expertOptions';
import AlignPanel from '../components/AlignPanel';
import { Banner, Button, Card, Checkbox, Input, ProgressBar, SectionTitle, Select, Textarea, WordChip, formatDuration } from '../components/bits';

const DEFAULT_TEST_TEXT =
  'O żywocie ludzkim. Fraszki to wszytko, cokolwiek myślemy, fraszki to wszytko, cokolwiek czyniemy. Zacność, uroda, moc, pieniądze, sława, wszystko to minie jako polna trawa.';

/** bench draft: raw strings from inputs; '' = unset (server default applies) */
type Draft = Record<string, string>;

function defOf(name: string): ExpertOptionDef | undefined {
  return EXPERT_OPTIONS.find((o) => o.name === name);
}

function draftToOptions(draft: Draft): ExpertOptions {
  const out: ExpertOptions = {};
  for (const [name, raw] of Object.entries(draft)) {
    const def = defOf(name);
    if (!def || raw.trim() === '') continue;
    if (def.type === 'bool') out[name] = raw === 'true';
    else if (def.type === 'int') out[name] = Math.round(Number(raw));
    else if (def.type === 'float') out[name] = Number(raw);
    else out[name] = raw;
  }
  return out;
}

function optionsToDraft(options: ExpertOptions | null | undefined): Draft {
  const d: Draft = {};
  if (!options) return d;
  for (const [k, v] of Object.entries(options)) d[k] = String(v);
  return d;
}

function optionsSummary(options: ExpertOptions): string {
  const entries = Object.entries(options);
  if (entries.length === 0) return '(defaults)';
  return entries.map(([k, v]) => `${k}=${v}`).join(' ');
}

function werPct(qa: ChunkQa | null): number | null {
  return qa?.wer ?? null;
}

function werClass(wer: number | null): string {
  if (wer === null) return 'text-zinc-500';
  if (wer === 0) return 'text-emerald-400';
  if (wer <= 0.1) return 'text-lime-400';
  if (wer <= 0.3) return 'text-amber-400';
  return 'text-red-400';
}

function isPerfect(qa: ChunkQa | null): boolean {
  return !!qa && qa.missingCount === 0 && qa.extra.length === 0;
}

function rankByWer<T>(rows: T[], werOf: (r: T) => number | null): T[] {
  return [...rows].sort((a, b) => {
    const wa = werOf(a);
    const wb = werOf(b);
    if (wa === null && wb === null) return 0;
    if (wa === null) return 1;
    if (wb === null) return -1;
    return wa - wb;
  });
}

/**
 * Clone-doctor playbook: tried in order on top of the bench options, same
 * sentence + seed, ranked by WER. Ordered roughly by expected payoff per
 * GPU-second; the loop stops early on a perfect take.
 */
const DOCTOR_VARIANTS: Array<{ label: string; options: ExpertOptions }> = [
  { label: 'baseline — current bench options', options: {} },
  { label: 'speed 0.9 — more room per word', options: { speed: 0.9 } },
  { label: 'class_temperature 0.3 — unstick repeats', options: { class_temperature: 0.3 } },
  { label: 'shift 0.15 — longer diffusion schedule', options: { shift: 0.15 } },
  { label: 'steps 48 — more faithful text', options: { num_inference_steps: 48 } },
];

export default function VoiceExpert() {
  const { id = '' } = useParams();
  const [voice, setVoice] = useState<VoiceDetail | null>(null);
  const [name, setName] = useState('');
  const [transcript, setTranscript] = useState('');
  const [audioVer, setAudioVer] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [takes, setTakes] = useState<VoiceTake[]>([]);
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT);
  const [language, setLanguage] = useState('pl');
  const [seed, setSeed] = useState('');
  const [lastRun, setLastRun] = useState<{ url: string; result: ExpertRunResult } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // sweep state
  const [sweepParam, setSweepParam] = useState('guidance_scale');
  const [sweepValues, setSweepValues] = useState('2, 2.5, 3');
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<{ idx: number; total: number } | null>(null);
  const [sweepResults, setSweepResults] = useState<Array<{ value: string; result: ExpertRunResult; takeId?: string }>>([]);
  const [sweepEarlyStop, setSweepEarlyStop] = useState(true);
  const [sweepAutoApply, setSweepAutoApply] = useState(false);

  // clone-doctor state (one-click auto-tune)
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorProgress, setDoctorProgress] = useState<{ idx: number; total: number; label: string } | null>(null);
  const [doctorResults, setDoctorResults] = useState<Array<{ label: string; options: ExpertOptions; result: ExpertRunResult }>>([]);
  const [doctorAutoApply, setDoctorAutoApply] = useState(true);

  // reference-cleanup state
  const [clean, setClean] = useState({
    start: '', end: '', highpassHz: '', lowpassHz: '', denoiseStrength: '',
    gainDb: '', fadeInSec: '', fadeOutSec: '', shortenPauses: '',
    loudnorm: false, compressor: false, trimSilence: true,
  });
  const [cleanPreview, setCleanPreview] = useState<{ url: string; durationMs: number; sizeBytes: number } | null>(null);
  const [cleanAsName, setCleanAsName] = useState('');
  const [analysis, setAnalysis] = useState<VoiceAnalysis | null>(null);

  const refreshVoice = useCallback(async () => {
    try {
      const v = await api.getVoice(id);
      setVoice(v);
      setName(v.name);
      setTranscript(v.reference_text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  const refreshTakes = useCallback(async () => {
    try {
      setTakes(await api.listTakes(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void refreshVoice();
    void refreshTakes();
  }, [refreshVoice, refreshTakes]);

  const refUrl = `${api.audioUrl.voice(id)}?v=${audioVer}`;

  const runTest = async () => {
    setBusy('test');
    setError('');
    setNotice('');
    try {
      const result = await api.expertRun(id, {
        text: testText,
        language: language.trim() || undefined,
        seed: seed.trim() || undefined,
        options: draftToOptions(draft),
        saveTake: true,
      });
      setLastRun({
        url: URL.createObjectURL(new Blob([Uint8Array.from(atob(result.audio_base64), (c) => c.charCodeAt(0))], { type: 'audio/wav' })),
        result,
      });
      await refreshTakes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const applyTake = async (take: { options: ExpertOptions }) => {
    setError('');
    try {
      await api.updateVoice(id, { synthOptions: take.options });
      setDraft(optionsToDraft(take.options));
      await refreshVoice();
      setNotice('★ options applied — generation now uses them for this voice');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const resetApplied = async () => {
    setError('');
    try {
      await api.updateVoice(id, { synthOptions: null });
      setDraft({});
      await refreshVoice();
      setNotice('applied options cleared — generation uses defaults again');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteTake = async (takeId: string) => {
    setError('');
    try {
      await api.deleteTake(id, takeId);
      if (sweepResults.some((r) => r.takeId === takeId)) {
        setSweepResults((rs) => rs.filter((r) => r.takeId !== takeId));
      }
      await refreshTakes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---------- sweep ----------
  const runSweep = async () => {
    const values = sweepValues.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (values.length === 0) {
      setError('sweep needs at least one value');
      return;
    }
    const def = defOf(sweepParam);
    if (sweepParam !== '__seed' && !def) return;
    setSweepRunning(true);
    setError('');
    setNotice('');
    setSweepResults([]);
    const base = draftToOptions(draft);
    try {
      const results: Array<{ value: string; result: ExpertRunResult; takeId?: string }> = [];
      for (let i = 0; i < values.length; i++) {
        const raw = values[i] ?? '';
        setSweepProgress({ idx: i, total: values.length });
        const value: string | number | boolean | undefined = sweepParam === '__seed'
          ? undefined
          : def!.type === 'bool'
            ? raw === 'true'
            : def!.type === 'string'
              ? raw
              : Number(raw);
        const result = await api.expertRun(id, {
          text: testText,
          language: language.trim() || undefined,
          seed: sweepParam === '__seed' ? raw || undefined : seed.trim() || undefined,
          options: sweepParam === '__seed' ? base : { ...base, [sweepParam]: value },
          saveTake: true,
        });
        results.push({ value: raw, result, takeId: result.takeId });
        setSweepResults([...results]);
        if (sweepEarlyStop && isPerfect(result.qa)) break; // don't burn GPU on takes we already beat
      }
      setSweepProgress(null);
      await refreshTakes();
      const best = rankByWer(results, (r) => werPct(r.result.qa))[0];
      if (sweepAutoApply && best && werPct(best.result.qa) !== null) {
        await applySweepValue(best.value);
      } else {
        setNotice('sweep complete — ranked by word error rate below');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSweepProgress(null);
    } finally {
      setSweepRunning(false);
    }
  };

  const sweepRanked = useMemo(
    () => rankByWer(sweepResults, (r) => werPct(r.result.qa)),
    [sweepResults],
  );

  const bestSweepValue = sweepRanked[0]?.value ?? null;

  const applySweepValue = async (value: string) => {
    if (sweepParam === '__seed') {
      setSeed(value);
      setNotice(`seed ${value} set in the test bench — rerun it with your options to confirm`);
      return;
    }
    const def = defOf(sweepParam);
    if (!def) return;
    const parsed: string | number | boolean = def.type === 'bool' ? value === 'true' : def.type === 'string' ? value : Number(value);
    const options = { ...draftToOptions(draft), [sweepParam]: parsed };
    await applyTake({ options });
  };

  // ---------- clone doctor (one-click auto-tune) ----------
  const runDoctor = async () => {
    setDoctorRunning(true);
    setError('');
    setNotice('');
    setDoctorResults([]);
    const base = draftToOptions(draft);
    // one fixed seed for the whole diagnosis so variants are comparable
    const runSeed = seed.trim() || String(Math.floor(Math.random() * 1_000_000));
    if (!seed.trim()) setSeed(runSeed);
    try {
      const rows: Array<{ label: string; options: ExpertOptions; result: ExpertRunResult }> = [];
      for (let i = 0; i < DOCTOR_VARIANTS.length; i++) {
        const v = DOCTOR_VARIANTS[i]!;
        setDoctorProgress({ idx: i, total: DOCTOR_VARIANTS.length, label: v.label });
        const options = { ...base, ...v.options };
        const result = await api.expertRun(id, {
          text: testText,
          language: language.trim() || undefined,
          seed: runSeed,
          options,
          saveTake: true,
        });
        rows.push({ label: v.label, options, result });
        setDoctorResults([...rows]);
        if (isPerfect(result.qa)) break; // perfect take — no need to keep trying
      }
      setDoctorProgress(null);
      await refreshTakes();
      const baseline = rows[0];
      const best = rankByWer(rows.slice(1), (r) => werPct(r.result.qa))[0];
      if (doctorAutoApply && best && werPct(best.result.qa) !== null) {
        const baseWer = baseline ? werPct(baseline.result.qa) : null;
        if (baseWer === null || (werPct(best.result.qa) ?? 1) < baseWer) {
          await applyTake({ options: best.options });
          setNotice(`doctor applied "${best.label}" — it beat the baseline on WER`);
          return;
        }
      }
      setNotice('doctor finished — see the ranking below (baseline was already the best)');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDoctorProgress(null);
    } finally {
      setDoctorRunning(false);
    }
  };

  // ---------- reference cleanup ----------
  const cleanOptions = (): CleanupOptions => ({
    start: clean.start.trim() !== '' ? Number(clean.start) : null,
    end: clean.end.trim() !== '' ? Number(clean.end) : null,
    highpassHz: clean.highpassHz.trim() !== '' ? Number(clean.highpassHz) : 0,
    lowpassHz: clean.lowpassHz.trim() !== '' ? Number(clean.lowpassHz) : 0,
    denoiseStrength: clean.denoiseStrength.trim() !== '' ? Number(clean.denoiseStrength) : 0,
    gainDb: clean.gainDb.trim() !== '' ? Number(clean.gainDb) : 0,
    fadeInSec: clean.fadeInSec.trim() !== '' ? Number(clean.fadeInSec) : 0,
    fadeOutSec: clean.fadeOutSec.trim() !== '' ? Number(clean.fadeOutSec) : 0,
    shortenPauses: clean.shortenPauses.trim() !== '' ? Number(clean.shortenPauses) : 0,
    loudnorm: clean.loudnorm,
    compressor: clean.compressor,
    trimSilence: clean.trimSilence,
  });

  const runCleanPreview = async () => {
    setBusy('clean');
    setError('');
    setNotice('');
    try {
      const prev = await api.cleanupVoice(id, cleanOptions());
      if (cleanPreview) URL.revokeObjectURL(cleanPreview.url);
      setCleanPreview(prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const cleanPreviewFile = async (): Promise<File> => {
    if (!cleanPreview) throw new Error('run the preview first');
    const blob = await (await fetch(cleanPreview.url)).blob();
    return new File([blob], 'voice-clean.wav', { type: 'audio/wav' });
  };

  const saveCleanAsReference = async () => {
    setBusy('clean-save');
    setError('');
    setNotice('');
    try {
      const file = await cleanPreviewFile();
      await api.replaceVoiceAudio(id, file);
      setAudioVer((v) => v + 1);
      await refreshVoice();
      setNotice('cleaned clip saved as the reference audio');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const saveCleanAsNewVoice = async () => {
    setBusy('clean-new');
    setError('');
    setNotice('');
    try {
      if (!cleanAsName.trim()) throw new Error('give the new voice a name');
      const file = await cleanPreviewFile();
      const r = await api.uploadVoice(cleanAsName.trim(), transcript, file);
      setCleanAsName('');
      setNotice(`saved as new voice (${r.id}) — find it in Voices`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  // ---------- reference analysis (suggest cleanup automatically) ----------
  const runAnalyze = async () => {
    setBusy('analyze');
    setError('');
    setNotice('');
    try {
      setAnalysis(await api.analyzeVoice(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  /** Fill the cleanup form from the analysis and immediately preview it. */
  const applySuggestions = async () => {
    if (!analysis) return;
    const s = analysis.suggestions;
    setClean((c) => ({
      ...c,
      start: s.start !== null && s.start !== undefined ? String(s.start) : '',
      end: s.end !== null && s.end !== undefined ? String(s.end) : '',
      highpassHz: s.highpassHz ? String(s.highpassHz) : '',
      lowpassHz: s.lowpassHz ? String(s.lowpassHz) : '',
      denoiseStrength: s.denoiseStrength ? String(s.denoiseStrength) : '',
      gainDb: s.gainDb ? String(s.gainDb) : '',
      fadeInSec: s.fadeInSec ? String(s.fadeInSec) : '',
      fadeOutSec: s.fadeOutSec ? String(s.fadeOutSec) : '',
      loudnorm: !!s.loudnorm,
      compressor: !!s.compressor,
      trimSilence: s.trimSilence !== false,
    }));
    setBusy('clean');
    setError('');
    setNotice('');
    try {
      const prev = await api.cleanupVoice(id, s);
      if (cleanPreview) URL.revokeObjectURL(cleanPreview.url);
      setCleanPreview(prev);
      setNotice('suggestions applied to the form — preview updated, listen and save if it sounds right');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const saveName = async () => {
    if (!voice || name.trim() === '' || name.trim() === voice.name) return;
    setError('');
    try {
      await api.updateVoice(id, { name: name.trim() });
      await refreshVoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!voice && !error) {
    return <div className="text-zinc-400">loading…</div>;
  }

  const applied: ExpertOptions = voice?.synth_options ?? {};

  const copyOptionsJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(applied, null, 2)).then(
      () => setNotice('options JSON copied to the clipboard'),
      () => setError('clipboard write failed — select the chips manually'),
    );
  };

  return (
    <div className="space-y-6">
      {/* ---------- header ---------- */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/voices" className="text-sm text-zinc-400 hover:text-zinc-200">← Voices</Link>
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">🧪 Expert mode</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <Input
            className="text-lg font-medium max-w-[320px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
          />
          <Button variant="ghost" onClick={() => void new Audio(refUrl).play()} title="original reference audio">
            🔊 reference
          </Button>
          <span className="text-xs text-zinc-500">
            reference {formatDuration(voice?.duration_ms ?? null)}
            {transcript.trim() ? '' : ' · no transcript yet — add one below (cloning is much better with it)'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
          <span className="text-zinc-500">used in generation:</span>
          {Object.keys(applied).length === 0 ? (
            <span className="text-zinc-500 italic">defaults (nothing applied)</span>
          ) : (
            Object.entries(applied).map(([k, v]) => (
              <span key={k} className="rounded bg-emerald-950 border border-emerald-800 text-emerald-300 px-1.5 py-0.5">
                {k}={String(v)}
              </span>
            ))
          )}
          {Object.keys(applied).length > 0 && (
            <Button variant="link" size="sm" onClick={copyOptionsJson} title="copy the applied options as JSON">copy JSON</Button>
          )}
          {Object.keys(applied).length > 0 && (
            <Button variant="ghost" onClick={resetApplied} title="back to server defaults in generation">reset all</Button>
          )}
        </div>
      </Card>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}

      {/* ---------- transcript & alignment ---------- */}
      <Card title="Reference transcript">
        <AlignPanel voiceId={id} transcript={transcript} onTranscriptChange={setTranscript} onSaved={refreshVoice} onError={setError} />
      </Card>

      {/* ---------- reference cleanup ---------- */}
      <Card>
        <SectionTitle className="mb-1">Reference cleanup</SectionTitle>
        <p className="text-xs text-zinc-500 mb-3">
          Adjust the provided voice file before it reaches the cloner: cut, filters, noise reduction, loudness, fades.
          Preview first — nothing is saved until you save it.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <CleanField label="cut start (s)" value={clean.start} onChange={(v) => setClean({ ...clean, start: v })} placeholder="0" />
          <CleanField label="cut end (s)" value={clean.end} onChange={(v) => setClean({ ...clean, end: v })} placeholder="whole file" />
          <CleanField label="high-pass (Hz)" value={clean.highpassHz} onChange={(v) => setClean({ ...clean, highpassHz: v })} placeholder="rumble, e.g. 80" />
          <CleanField label="low-pass (Hz)" value={clean.lowpassHz} onChange={(v) => setClean({ ...clean, lowpassHz: v })} placeholder="hiss, e.g. 12000" />
          <CleanField label="denoise (1-100)" value={clean.denoiseStrength} onChange={(v) => setClean({ ...clean, denoiseStrength: v })} placeholder="e.g. 12" />
          <CleanField label="gain (dB)" value={clean.gainDb} onChange={(v) => setClean({ ...clean, gainDb: v })} placeholder="0" />
          <CleanField label="fade in (s)" value={clean.fadeInSec} onChange={(v) => setClean({ ...clean, fadeInSec: v })} placeholder="0" />
          <CleanField label="fade out (s)" value={clean.fadeOutSec} onChange={(v) => setClean({ ...clean, fadeOutSec: v })} placeholder="0" />
          <CleanField label="max pause (s)" value={clean.shortenPauses} onChange={(v) => setClean({ ...clean, shortenPauses: v })} placeholder="compress pauses, e.g. 0.3" />
        </div>
        <div className="flex flex-wrap items-center gap-4 mt-3 text-sm">
          <label className="flex items-center gap-1.5 text-zinc-300">
            <Checkbox checked={clean.loudnorm} onChange={(e) => setClean({ ...clean, loudnorm: e.target.checked })} />
            loudness normalize (-20 LUFS)
          </label>
          <label className="flex items-center gap-1.5 text-zinc-300">
            <Checkbox checked={clean.compressor} onChange={(e) => setClean({ ...clean, compressor: e.target.checked })} />
            compressor
          </label>
          <label className="flex items-center gap-1.5 text-zinc-300">
            <Checkbox checked={clean.trimSilence} onChange={(e) => setClean({ ...clean, trimSilence: e.target.checked })} />
            trim edge silence
          </label>
          <Button onClick={runCleanPreview} disabled={busy !== ''}>
            {busy === 'clean' ? 'processing…' : '▶ preview'}
          </Button>
          <Button onClick={runAnalyze} disabled={busy !== ''} title="measure loudness and edge silence, suggest cleanup settings">
            {busy === 'analyze' ? 'measuring…' : '🔍 analyze'}
          </Button>
        </div>

        {analysis && (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs space-y-1">
            <div className="text-zinc-500">
              {analysis.durationSec.toFixed(1)} s
              {analysis.peakDb !== null && <> · peak {analysis.peakDb.toFixed(1)} dBFS</>}
              {analysis.meanDb !== null && <> · mean {analysis.meanDb.toFixed(1)} dB</>}
              {analysis.leadingSilenceSec > 0.05 && <> · leading silence {analysis.leadingSilenceSec.toFixed(2)} s</>}
              {analysis.trailingSilenceSec > 0.05 && <> · trailing silence {analysis.trailingSilenceSec.toFixed(2)} s</>}
            </div>
            <ul className="list-disc list-inside text-zinc-400">
              {analysis.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
            <Button variant="primary" onClick={applySuggestions} disabled={busy !== ''}>
              ✨ apply suggestions & preview
            </Button>
          </div>
        )}

        {cleanPreview && (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-3">
            <div className="text-xs text-zinc-500">
              processed: {(cleanPreview.durationMs / 1000).toFixed(1)} s · {(cleanPreview.sizeBytes / 1024).toFixed(0)} KiB
              {cleanPreview.sizeBytes > 3.5 * 1024 * 1024 && <span className="text-red-400"> · over the 3.5 MiB reference limit — cut it shorter</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-500 mb-1">cleaned</div>
                <audio controls src={cleanPreview.url} className="w-full" />
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1">original (A/B)</div>
                <audio controls src={refUrl} className="w-full" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={saveCleanAsReference} disabled={busy !== ''}>
                {busy === 'clean-save' ? 'saving…' : '💾 save as reference'}
              </Button>
              <Input
                size="sm"
                className="w-44"
                placeholder="new voice name…"
                value={cleanAsName}
                onChange={(e) => setCleanAsName(e.target.value)}
              />
              <Button onClick={saveCleanAsNewVoice} disabled={busy !== ''}>
                {busy === 'clean-new' ? 'saving…' : '💾 save as new voice'}
              </Button>
              <Button variant="ghost" onClick={() => { URL.revokeObjectURL(cleanPreview.url); setCleanPreview(null); }}>
                discard preview
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ---------- parameter bench ---------- */}
      <Card>
        <SectionTitle className="mb-1">Parameter bench</SectionTitle>
        <p className="text-xs text-zinc-500 mb-3">
          Full OmniVoice option surface. Empty = server default. Options marked <span className="rounded bg-zinc-800 border border-zinc-700 px-1">book wins</span> are
          overridden by per-book steps/guidance/speed during generation, but you can still test them here.
        </p>
        <div className="space-y-4">
          <BenchGroup
            title="Delivery"
            defs={EXPERT_OPTIONS.filter((o) => ['instruct', 'speed', 'duration_sec'].includes(o.name))}
            draft={draft}
            setDraft={setDraft}
          />
          <BenchGroup
            title="Quality"
            defs={EXPERT_OPTIONS.filter((o) => ['num_inference_steps', 'guidance_scale', 'shift'].includes(o.name))}
            draft={draft}
            setDraft={setDraft}
          />
          <BenchGroup
            title="Sampling"
            defs={EXPERT_OPTIONS.filter((o) => ['layer_penalty_factor', 'position_temperature', 'class_temperature', 'denoise', 'preprocess_prompt', 'postprocess_output'].includes(o.name))}
            draft={draft}
            setDraft={setDraft}
          />
        </div>
      </Card>

      {/* ---------- test bench ---------- */}
      <Card>
        <SectionTitle className="mb-1">Test bench</SectionTitle>
        <p className="text-xs text-zinc-500 mb-3">
          Synthesizes one sentence with the bench options above, transcribes it back and scores every word.
          Each take ≈ 20–40 s of GPU and is saved to the takes table.
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Input
            size="sm"
            className="flex-1 min-w-[240px]"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            title="sentence the clone must say"
          />
          <Input
            size="sm"
            className="w-16"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="language hint (synthesis + ASR)"
          />
          <Input
            size="sm"
            className="w-24"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="seed (rand)"
            title="empty = random"
          />
          <Button variant="primary" onClick={runTest} disabled={busy !== '' || sweepRunning}>
            {busy === 'test' ? 'running…' : '▶ run + score'}
          </Button>
        </div>
        {lastRun && (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs space-y-1">
            <div className="text-zinc-500">{optionsSummary(lastRun.result.options)}</div>
            <QaLine qa={lastRun.result.qa} durationMs={lastRun.result.duration_ms} />
            <div>
              <Button variant="link" size="sm" className="text-sky-400" onClick={() => void new Audio(lastRun.url).play()}>▶ hear the take</Button>
            </div>
          </div>
        )}
      </Card>

      {/* ---------- clone doctor ---------- */}
      <Card>
        <SectionTitle className="mb-1">🩺 Clone doctor</SectionTitle>
        <p className="text-xs text-zinc-500 mb-3">
          One click: tries a curated sequence of fixes on top of your bench options (same sentence + one fixed seed),
          stops early on a perfect take, and applies the winner automatically. Up to {DOCTOR_VARIANTS.length} takes ≈ 2 min of GPU.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={runDoctor} disabled={busy !== '' || doctorRunning || sweepRunning}>
            {doctorRunning ? (doctorProgress ? `trying: ${doctorProgress.label} (${doctorProgress.idx + 1}/${doctorProgress.total})` : 'diagnosing…') : '🩺 diagnose & fix'}
          </Button>
          <label className="flex items-center gap-1.5 text-sm text-zinc-300">
            <Checkbox checked={doctorAutoApply} onChange={(e) => setDoctorAutoApply(e.target.checked)} />
            apply the winner automatically
          </label>
        </div>
        {doctorRunning && doctorProgress && (
          <div className="mt-3">
            <ProgressBar done={doctorProgress.idx + 1} total={doctorProgress.total} />
          </div>
        )}
        {doctorResults.length > 0 && (
          <div className="mt-4 space-y-1">
            {rankByWer(doctorResults, (r) => werPct(r.result.qa)).map((r, i) => {
              const wer = werPct(r.result.qa);
              const baselineWer = doctorResults[0] ? werPct(doctorResults[0].result.qa) : null;
              return (
                <div
                  key={r.label}
                  className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                    i === 0 && wer !== null ? 'border-emerald-700 bg-emerald-950/40' : 'border-zinc-800 bg-zinc-950/60'
                  }`}
                >
                  <span className={`font-medium ${i === 0 && wer !== null ? 'text-emerald-300' : 'text-zinc-300'}`}>
                    {i === 0 && wer !== null && wer !== baselineWer ? '🏆 ' : ''}{r.label}
                  </span>
                  <span className={werClass(wer)}>WER {wer === null ? 'n/a' : `${(wer * 100).toFixed(1)}%`}</span>
                  {r.result.qa && r.result.qa.missing.length > 0 && (
                    <span className="text-red-400 text-xs">missing: {r.result.qa.missing.join(', ')}</span>
                  )}
                  <span className="text-zinc-600 text-xs">{(r.result.duration_ms / 1000).toFixed(1)}s</span>
                  <Button variant="link" size="sm" className="text-emerald-400 ml-auto" onClick={() => void applyTake({ options: r.options })}>
                    ★ apply
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ---------- takes ---------- */}
      <Card title={`Takes (${takes.length})`}>
        {takes.length === 0 && <div className="text-sm text-zinc-500">No takes yet — run the test bench or a sweep.</div>}
        {takes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                  <th className="py-2 pr-3">when</th>
                  <th className="py-2 pr-3">options</th>
                  <th className="py-2 pr-3">WER</th>
                  <th className="py-2 pr-3">missing</th>
                  <th className="py-2 pr-3">audio</th>
                  <th className="py-2 pr-3" />
                </tr>
              </thead>
              <tbody>
                {takes.map((t) => {
                  const wer = werPct(t.qa);
                  return (
                    <tr key={t.id} className="border-b border-zinc-800/60 align-top">
                      <td className="py-2 pr-3 text-xs text-zinc-500 whitespace-nowrap">
                        {new Date(t.created_at).toLocaleTimeString()}
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-400 max-w-[280px] break-words">
                        {optionsSummary(t.options)}
                        <div className="text-zinc-600 truncate max-w-[280px]" title={t.text}>{t.text}</div>
                      </td>
                      <td className={`py-2 pr-3 font-medium ${werClass(wer)}`}>
                        {wer === null ? 'n/a' : `${(wer * 100).toFixed(1)}%`}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {t.qa && t.qa.missing.length > 0 ? (
                          <span className="text-red-400">{t.qa.missing.slice(0, 6).join(', ')}{t.qa.missing.length > 6 ? '…' : ''}</span>
                        ) : (
                          <span className="text-emerald-400">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <Button
                          variant="link"
                          size="sm"
                          className="text-sky-400"
                          onClick={() => void new Audio(api.audioUrl.take(id, t.id)).play()}
                        >
                          ▶ {(t.duration_ms / 1000).toFixed(1)}s
                        </Button>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Button
                          variant="link"
                          size="sm"
                          className="text-emerald-400 mr-3"
                          title="save these options to the voice — generation will use them"
                          onClick={() => void applyTake(t)}
                        >
                          ★ apply
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          title="delete this take"
                          onClick={() => {
                            if (!window.confirm('Delete this take?')) return;
                            void deleteTake(t.id);
                          }}
                        >
                          🗑
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---------- sweep builder ---------- */}
      <Card>
        <SectionTitle className="mb-1">Sweep builder</SectionTitle>
        <p className="text-xs text-zinc-500 mb-3">
          Try one parameter over several values with the same sentence. Takes are saved and ranked by WER —
          runs sequentially, each value ≈ 20–40 s of GPU.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={sweepParam}
            onChange={(e) => setSweepParam(e.target.value)}
          >
            <option value="__seed">Seed (randomness)</option>
            {EXPERT_OPTIONS.filter((o) => o.type !== 'string').map((o) => (
              <option key={o.name} value={o.name}>{o.label} ({o.name})</option>
            ))}
          </Select>
          <span className="text-zinc-500 text-sm">=</span>
          <Input
            className="flex-1 min-w-[200px]"
            value={sweepValues}
            onChange={(e) => setSweepValues(e.target.value)}
            placeholder={sweepParam === '__seed' ? 'e.g. 1234, 5678, 90210' : 'comma-separated values, e.g. 2, 2.5, 3'}
          />
          <Button variant="primary" onClick={runSweep} disabled={busy !== '' || sweepRunning || doctorRunning}>
            {sweepRunning ? `sweeping ${sweepProgress ? `${sweepProgress.idx + 1}/${sweepProgress.total}` : '…'}` : '▶ run sweep'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 mt-2 text-sm">
          <label className="flex items-center gap-1.5 text-zinc-300" title="stop the sweep as soon as a take says every word perfectly — saves GPU time">
            <Checkbox checked={sweepEarlyStop} onChange={(e) => setSweepEarlyStop(e.target.checked)} />
            stop on perfect take
          </label>
          <label className="flex items-center gap-1.5 text-zinc-300" title="after the sweep, save the lowest-WER value to the voice">
            <Checkbox checked={sweepAutoApply} onChange={(e) => setSweepAutoApply(e.target.checked)} />
            auto-apply winner
          </label>
        </div>
        {sweepRunning && sweepProgress && (
          <div className="mt-3">
            <ProgressBar done={sweepProgress.idx + 1} total={sweepProgress.total} />
          </div>
        )}
        {sweepRanked.length > 0 && (
          <div className="mt-4 space-y-1">
            {sweepRanked.map((r, i) => {
              const wer = werPct(r.result.qa);
              return (
                <div
                  key={`${r.value}-${r.takeId ?? i}`}
                  className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                    i === 0 && wer !== null ? 'border-emerald-700 bg-emerald-950/40' : 'border-zinc-800 bg-zinc-950/60'
                  }`}
                >
                  <span className={`font-medium ${i === 0 && wer !== null ? 'text-emerald-300' : 'text-zinc-300'}`}>
                    {i === 0 && wer !== null ? '🏆 ' : ''}{sweepParam}={r.value}
                  </span>
                  <span className={werClass(wer)}>WER {wer === null ? 'n/a' : `${(wer * 100).toFixed(1)}%`}</span>
                  {r.result.qa && r.result.qa.missing.length > 0 && (
                    <span className="text-red-400 text-xs">missing: {r.result.qa.missing.join(', ')}</span>
                  )}
                  <span className="text-zinc-600 text-xs">{(r.result.duration_ms / 1000).toFixed(1)}s</span>
                  <Button
                    variant="link"
                    size="sm"
                    className="text-emerald-400 ml-auto"
                    onClick={() => void applySweepValue(r.value)}
                  >
                    ★ {sweepParam === '__seed' ? 'use seed' : 'apply'} {r.value === bestSweepValue ? 'best' : ''}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function CleanField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-400 mb-1">{label}</span>
      <Input
        className="w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
      />
    </label>
  );
}

function BenchGroup({ title, defs, draft, setDraft }: { title: string; defs: ExpertOptionDef[]; draft: Draft; setDraft: Dispatch<SetStateAction<Draft>> }) {
  return (
    <div>
      <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">{title}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {defs.map((def) => (
          <BenchField key={def.name} def={def} draft={draft} setDraft={setDraft} />
        ))}
      </div>
    </div>
  );
}

function BenchField({ def, draft, setDraft }: { def: ExpertOptionDef; draft: Draft; setDraft: Dispatch<SetStateAction<Draft>> }) {
  const value = draft[def.name] ?? '';
  const isDefault = value === '';
  const set = (v: string) => setDraft((d) => ({ ...d, [def.name]: v }));

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-zinc-300">{def.label}</span>
          {def.scope === 'book-owned' && (
            <span className="rounded bg-zinc-800 border border-zinc-700 px-1 text-[10px] text-zinc-400" title="per-book setting overrides this in generation">book wins</span>
          )}
          {isDefault && def.specDefault !== undefined && (
            <span className="text-[10px] text-zinc-600">default {String(def.specDefault)}</span>
          )}
          {!isDefault && (
            <button className="text-[10px] text-zinc-500 hover:text-zinc-300" onClick={() => set('')} title="back to default">
              ↺ reset
            </button>
          )}
        </div>
        {def.type === 'bool' ? (
          <Select
            className="w-full"
            value={value}
            onChange={(e) => set(e.target.value)}
            title={def.description}
          >
            <option value="">default ({String(def.specDefault ?? '?')})</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </Select>
        ) : def.type === 'string' ? (
          <Textarea
            className="w-full min-h-[36px]"
            value={value}
            onChange={(e) => set(e.target.value)}
            placeholder={def.description}
            title={def.description}
            rows={2}
          />
        ) : (
          <Input
            className="w-full"
            value={value}
            onChange={(e) => set(e.target.value)}
            placeholder={`default ${def.specDefault !== undefined ? String(def.specDefault) : 'auto'}`}
            title={def.description}
            inputMode="decimal"
          />
        )}
      </div>
    </div>
  );
}

function QaLine({ qa, durationMs }: { qa: ChunkQa | null; durationMs: number }) {
  if (!qa) return <div className="text-zinc-500">audio generated ({(durationMs / 1000).toFixed(1)}s) — ASR unavailable for scoring</div>;
  if (qa.missing.length === 0 && qa.extra.length === 0) {
    return (
      <div className="text-emerald-400">
        ✓ all {qa.sourceWords} words spoken ({(durationMs / 1000).toFixed(1)}s audio, WER 0%)
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className={qa.missing.length > 0 ? 'text-red-400' : 'text-amber-400'}>
        {qa.missing.length > 0
          ? `✗ dropped ${qa.missingCount} of ${qa.sourceWords} words (WER ${(qa.wer! * 100).toFixed(1)}%)`
          : `△ all words present but ASR heard extras (WER ${(qa.wer! * 100).toFixed(1)}%)`}
      </div>
      {qa.missing.length > 0 && (
        <div>
          {qa.missing.map((m, i) => <WordChip key={i} word={m} kind="missing" />)}
        </div>
      )}
      {qa.extra.length > 0 && (
        <div>
          <span className="text-amber-400">not in text:</span>{' '}
          {qa.extra.map((m, i) => <WordChip key={i} word={m} kind="extra" />)}
        </div>
      )}
    </div>
  );
}
