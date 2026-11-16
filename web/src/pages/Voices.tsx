import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { api, onStudioEvent, type CloneTest, type Voice } from '../lib/api';
import AlignPanel from '../components/AlignPanel';
import { Banner, Button, Card, Checkbox, Input, Textarea, WordChip } from '../components/bits';

/**
 * Voice preparation studio:
 *   1. load any audio file -> waveform
 *   2. drag-select the cleanest single-speaker segment (5-20 s is ideal)
 *   3. "Prepare clip" -> server-side cut + mono 24 kHz + loudness normalize + silence trim
 *   4. "Auto-transcribe" -> CrisperWhisper (managed runtime) writes the transcript
 *   5. review/edit -> Save voice
 */
export default function Voices() {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [name, setName] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const [previewText, setPreviewText] = useState('To jest krótki przykład głosu narratora. Dzień dobry, witaj w audiobookach.');
  const [language, setLanguage] = useState('');
  const [normalize, setNormalize] = useState(true);
  const [denoise, setDenoise] = useState(true);
  const [stage, setStage] = useState<'idle' | 'source' | 'prepared'>('idle');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selectionLabel, setSelectionLabel] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [playingSelection, setPlayingSelection] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const sourceFileRef = useRef<File | null>(null);
  const preparedBlobRef = useRef<Blob | null>(null);

  const refresh = useCallback(() => {
    api.listVoices().then(setVoices).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    return onStudioEvent((ev) => {
      if (ev.type === 'voices.update') refresh();
    });
  }, [refresh]);

  // wavesurfer lifecycle
  useEffect(() => {
    if (stage === 'idle' || !waveRef.current) return;
    const url = stage === 'prepared' && preparedBlobRef.current
      ? URL.createObjectURL(preparedBlobRef.current)
      : sourceFileRef.current
        ? URL.createObjectURL(sourceFileRef.current)
        : null;
    if (!url) return;

    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 96,
      waveColor: '#52525b',
      progressColor: '#34d399',
      cursorColor: '#a1a1aa',
      barWidth: 2,
      barGap: 1,
      url,
    });
    if (stage === 'source') {
      const regions = ws.registerPlugin(RegionsPlugin.create());
      regions.enableDragSelection({ color: 'rgba(52, 211, 153, 0.25)' });
      const onRegion = (r: { id: string; start: number; end: number }) => {
        for (const other of regions.getRegions()) if (other.id !== r.id) other.remove();
        setSelectionLabel(`selected ${r.start.toFixed(1)}–${r.end.toFixed(1)} s (${(r.end - r.start).toFixed(1)} s)`);
        setHasSelection(true);
      };
      regions.on('region-created', onRegion);
      regions.on('region-updated', onRegion);
      regions.on('region-removed', () => {
        setHasSelection(regions.getRegions().length > 0);
        setSelectionLabel(null);
      });
      regionsRef.current = regions;
    }
    // keep the listen-to-selection button label in sync with playback state
    ws.on('play', () => setPlayingSelection(true));
    ws.on('pause', () => setPlayingSelection(false));
    ws.on('finish', () => setPlayingSelection(false));
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      setPlayingSelection(false);
    };
  }, [stage]);

  const loadFile = (file: File) => {
    setError('');
    sourceFileRef.current = file;
    preparedBlobRef.current = null;
    setReferenceText('');
    setStage('source');
  };

  const selection = (): { start: number; end: number | null } => {
    const regions = regionsRef.current?.getRegions() ?? [];
    const r = regions[0];
    if (!r) return { start: 0, end: null };
    return { start: r.start, end: r.end };
  };

  /** Play exactly the selected segment — region.play() bounds playback to start..end. */
  const playSelection = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.isPlaying()) {
      ws.pause();
      return;
    }
    const r = regionsRef.current?.getRegions()[0];
    if (!r) return;
    r.play(true); // stopAtEnd — without it playback runs to the end of the file
  };

  const prepare = async () => {
    const file = sourceFileRef.current;
    if (!file) return;
    const { start, end } = selection();
    setBusy('prepare');
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('start', String(start));
      form.append('end', end === null ? '' : String(end));
      form.append('normalize', String(normalize));
      form.append('denoise', String(denoise));
      const res = await fetch('/api/voices/prepare', { method: 'POST', body: form });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status}`);
      }
      preparedBlobRef.current = await res.blob();
      setStage('prepared');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const transcribe = async () => {
    const blob = preparedBlobRef.current;
    if (!blob) return;
    setBusy('transcribe');
    setError('');
    try {
      const form = new FormData();
      form.append('file', blob, 'prepared.wav');
      if (language.trim()) form.append('language', language.trim());
      const res = await fetch('/api/voices/transcribe', { method: 'POST', body: form });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status}`);
      }
      const { text } = (await res.json()) as { text: string };
      setReferenceText(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    const blob = preparedBlobRef.current;
    if (!blob || !name.trim()) {
      setError('voice needs a name');
      return;
    }
    setBusy('save');
    setError('');
    try {
      const file = new File([blob], 'voice.wav', { type: 'audio/wav' });
      await api.uploadVoice(name.trim(), referenceText.trim(), file);
      setName('');
      setReferenceText('');
      sourceFileRef.current = null;
      preparedBlobRef.current = null;
      if (fileRef.current) fileRef.current.value = '';
      setStage('idle');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const preview = async (id: string) => {
    setPreviewingId(id);
    setError('');
    try {
      const url = await api.previewVoice(id, previewText);
      void new Audio(url).play();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewingId(null);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Voices</h1>
      {error && <Banner kind="error" className="mb-4">{error}</Banner>}

      {/* ---------- preparation studio ---------- */}
      <Card title="Prepare a voice for cloning" className="mb-6">

        <input
          ref={fileRef}
          type="file"
          accept=".wav,.mp3,.m4a,.ogg,.flac,.opus,audio/*"
          className="text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-700 file:px-3 file:py-1.5 file:text-zinc-200"
          onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
        />

        {stage !== 'idle' && (
          <div className="mt-3">
            <div ref={waveRef} className="rounded-lg bg-zinc-950 border border-zinc-800 px-2" />
            <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
              {stage === 'source' ? (
                <>
                  <span className="text-zinc-400">
                    {selectionLabel ?? 'drag on the waveform to select a segment'} — 5–20 s of clean single-speaker speech is ideal
                  </span>
                  <Button
                    variant="ghost"
                    disabled={!hasSelection}
                    onClick={playSelection}
                    title={hasSelection ? 'play only the selected segment' : 'drag on the waveform to select a segment first'}
                  >
                    {playingSelection ? '■ stop' : '▶ listen to selection'}
                  </Button>
                  <label className="flex items-center gap-1.5 text-zinc-400">
                    <Checkbox checked={denoise} onChange={(e) => setDenoise(e.target.checked)} />
                    reduce background noise
                  </label>
                  <label className="flex items-center gap-1.5 text-zinc-400" title="denoise first so the silence trim works on noisy sources">
                    <Checkbox checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
                    normalize loudness
                  </label>
                  <Button variant="primary" disabled={busy !== ''} onClick={prepare}>
                    {busy === 'prepare' ? 'preparing…' : '✂ Prepare clip'}
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-emerald-400">✓ clip prepared (mono 24 kHz, trimmed, {normalize ? 'normalized' : 'as-is'})</span>
                  <Button onClick={transcribe} disabled={busy !== ''}>
                    {busy === 'transcribe' ? 'transcribing…' : '🗣 Auto-transcribe'}
                  </Button>
                  <Input
                    size="sm"
                    className="w-24"
                    placeholder="lang (auto)"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    title="optional language hint, e.g. pl"
                  />
                  <Button variant="ghost" onClick={() => { setStage(sourceFileRef.current ? 'source' : 'idle'); preparedBlobRef.current = null; }}>
                    ↺ back to source
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-3 mt-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Voice name</label>
            <Input className="w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. narrator-2" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Transcript <span className="text-zinc-600">(exact words in the clip — auto-filled by transcription)</span>
            </label>
            <Textarea
              className="w-full min-h-[64px]"
              value={referenceText}
              onChange={(e) => setReferenceText(e.target.value)}
              placeholder="Transcript of the reference audio…"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" disabled={stage !== 'prepared' || busy !== ''} onClick={save} title={stage !== 'prepared' ? 'prepare a clip first' : ''}>
            {busy === 'save' ? 'Saving…' : '💾 Save voice'}
          </Button>
          <Input
            className="flex-1"
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            title="text used for the saved-voice preview below"
          />
        </div>
      </Card>

      {/* ---------- saved voices ---------- */}
      <div className="space-y-2">
        {voices.length === 0 && <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-zinc-400">No voices yet. Prepare one above — the transcript makes cloning noticeably better.</div>}
        {voices.map((v) => (
          <VoiceRow key={v.id} v={v} previewingId={previewingId} previewText={previewText} onPreview={preview} onChanged={refresh} onError={setError} />
        ))}
      </div>
    </div>
  );
}

function VoiceRow({
  v,
  previewingId,
  previewText,
  onPreview,
  onChanged,
  onError,
}: {
  v: Voice;
  previewingId: string | null;
  previewText: string;
  onPreview: (id: string) => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [name, setName] = useState(v.name);
  const [transcript, setTranscript] = useState(v.reference_text);
  const [saving, setSaving] = useState(false);
  const [pauseMs, setPauseMs] = useState(v.pause_target_ms != null ? String(v.pause_target_ms) : '');

  /** per-voice standard sentence pause; empty = follow global settings */
  const savePause = async (raw: string) => {
    const trimmed = raw.trim();
    const val = trimmed === '' ? null : Number(trimmed);
    if (val !== null && (!Number.isFinite(val) || val < 100 || val > 2000)) return;
    if ((v.pause_target_ms ?? null) === val) return;
    try {
      await api.updateVoice(v.id, { pauseTargetMs: val });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!editing) {
      setName(v.name);
      setTranscript(v.reference_text);
    }
  }, [v.name, v.reference_text, editing]);

  const save = async () => {
    if (!name.trim()) {
      onError('voice name cannot be empty');
      return;
    }
    setSaving(true);
    try {
      await api.updateVoice(v.id, { name: name.trim(), referenceText: transcript });
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <Input
                className="w-full font-medium"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="voice name"
              />
              <Textarea
                className="w-full min-h-[56px]"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="transcript (exact words of the reference clip)"
              />
              <div className="flex gap-2">
                <Button variant="primary" disabled={saving} onClick={save}>
                  {saving ? 'saving…' : 'save'}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="font-medium">{v.name}</div>
              <div className="text-sm text-zinc-500 truncate">{v.reference_text || 'no transcript'}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <span title="standard sentence pause for this voice (ms) — in-take breaks and chunk joins are normalized to it; empty = automatic (follows the narration's own natural pause rhythm)">
                  ⏸ breaks
                </span>
                <input
                  className="w-16 rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-xs"
                  value={pauseMs}
                  placeholder="auto"
                  onChange={(e) => setPauseMs(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && savePause(pauseMs)}
                  onBlur={() => savePause(pauseMs)}
                />
                <span>ms</span>
              </div>
            </>
          )}
        </div>
        {!editing && (
          <>
            <Button onClick={() => onPreview(v.id)} disabled={previewingId === v.id}>
              {previewingId === v.id ? 'generating…' : '▶ preview'}
            </Button>
            <Button variant="ghost" onClick={() => void new Audio(api.audioUrl.voice(v.id)).play()} title="hear the original reference">
              🔊 ref
            </Button>
            <Button variant={labOpen ? 'primary' : 'ghost'} onClick={() => setLabOpen((o) => !o)} title="verify the transcript word-by-word and test the clone">
              🔬 lab
            </Button>
            <Link
              to={`/voices/${v.id}/expert`}
              className="inline-flex items-center rounded-lg bg-transparent hover:bg-zinc-800 text-zinc-300 px-3 py-1.5 text-sm font-medium transition-colors"
              title="expert mode: reference cleanup, full parameter bench, sweeps"
            >
              🧪 expert
            </Link>
            <Button variant="ghost" onClick={() => setEditing(true)} title="rename / edit transcript">
              ✏ edit
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!window.confirm(`Delete voice "${v.name}" and its reference audio? Books using it keep working but lose the voice link.`)) return;
                await api.deleteVoice(v.id);
                onChanged();
              }}
            >
              delete
            </Button>
          </>
        )}
      </div>
      {labOpen && !editing && <CloneLab v={v} onChanged={onChanged} onError={onError} />}
    </Card>
  );
}

const DEFAULT_TEST_TEXT =
  'O żywocie ludzkim. Fraszki to wszytko, cokolwiek myślemy, fraszki to wszytko, cokolwiek czyniemy. Zacność, uroda, moc, pieniądze, sława, wszystko to minie jako polna trawa.';

/**
 * Clone lab: the clone's quality is bounded by the reference transcript —
 * wrong words there teach the model wrong word→sound mappings and generation
 * garbles or drops words. Two tools:
 *   1. Verify transcript — shared <AlignPanel> (forced alignment + word chips).
 *   2. Test clone — synthesize a sentence, transcribe it back, show what the
 *      clone itself drops BEFORE committing to a whole book.
 */
function CloneLab({ v, onChanged, onError }: { v: Voice; onChanged: () => void; onError: (msg: string) => void }) {
  const [transcript, setTranscript] = useState(v.reference_text);
  const [busy, setBusy] = useState('');
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT);
  const [language, setLanguage] = useState('pl');
  const [test, setTest] = useState<CloneTest | null>(null);
  const [testUrl, setTestUrl] = useState<string | null>(null);

  useEffect(() => {
    setTranscript(v.reference_text);
    setTest(null);
    setTestUrl(null);
  }, [v.id, v.reference_text]);

  const runTest = async () => {
    setBusy('test');
    onError('');
    try {
      const r = await api.testVoice(v.id, testText, language.trim() || undefined);
      setTest(r);
      setTestUrl(URL.createObjectURL(new Blob([Uint8Array.from(atob(r.audio_base64), (c) => c.charCodeAt(0))], { type: 'audio/wav' })));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-4">
      {/* --- transcript verification --- */}
      <AlignPanel
        voiceId={v.id}
        transcript={transcript}
        onTranscriptChange={setTranscript}
        onSaved={onChanged}
        onError={onError}
      />

      {/* --- clone round-trip test --- */}
      <div className="border-t border-zinc-800 pt-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Clone test</span>
          <Input
            size="sm"
            className="flex-1 min-w-[240px]"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            title="sentence the clone must say — defaults to Fraszki-style Polish"
          />
          <Input
            size="sm"
            className="w-20"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="language hint passed to synthesis and ASR"
          />
          <Button onClick={runTest} disabled={busy !== ''}>
            {busy === 'test' ? 'testing…' : '🧪 test clone'}
          </Button>
        </div>
        {test && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs space-y-1">
            {test.qa ? (
              test.qa.missing.length === 0 && test.qa.extra.length === 0 ? (
                <div className="text-emerald-400">
                  ✓ clone says all {test.qa.sourceWords} words ({(test.duration_ms / 1000).toFixed(1)}s audio)
                </div>
              ) : (
                <div className="space-y-1">
                  <div className={test.qa.missing.length > 0 ? 'text-red-400' : 'text-emerald-400'}>
                    {test.qa.missing.length > 0
                      ? `✗ clone dropped ${test.qa.missingCount} of ${test.qa.sourceWords} words — fix the transcript words above, then re-test`
                      : '✓ all words present'}
                  </div>
                  {test.qa.missing.length > 0 && (
                    <div>
                      {test.qa.missing.map((m, i) => <WordChip key={i} word={m} kind="missing" />)}
                    </div>
                  )}
                  {test.qa.extra.length > 0 && (
                    <div>
                      <span className="text-amber-400">not in text:</span>{' '}
                      {test.qa.extra.map((m, i) => <WordChip key={i} word={m} kind="extra" />)}
                    </div>
                  )}
                  {test.qa.variants.length > 0 && (
                    <div className="text-zinc-500">variants (ok): {test.qa.variants.join(', ')}</div>
                  )}
                </div>
              )
            ) : (
              <div className="text-zinc-500">audio generated ({(test.duration_ms / 1000).toFixed(1)}s) — ASR unavailable for scoring</div>
            )}
            {testUrl && (
              <div className="pt-1">
                <Button variant="link" size="sm" className="text-sky-400" onClick={() => void new Audio(testUrl).play()}>
                  ▶ hear the clone
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
