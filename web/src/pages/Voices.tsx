import { useCallback, useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { api, onStudioEvent, type Voice } from '../lib/api';
import { Button } from '../components/bits';

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
  const [stage, setStage] = useState<'idle' | 'source' | 'prepared'>('idle');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selectionLabel, setSelectionLabel] = useState<string | null>(null);
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
      };
      regions.on('region-created', onRegion);
      regions.on('region-updated', onRegion);
      regionsRef.current = regions;
    }
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
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
      {error && <div className="mb-4 rounded-lg bg-red-950 border border-red-800 text-red-200 px-4 py-2 text-sm">{error}</div>}

      {/* ---------- preparation studio ---------- */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 mb-6">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-3">Prepare a voice for cloning</h2>

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
                  <label className="flex items-center gap-1.5 text-zinc-400">
                    <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
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
                  <input
                    className="w-24 rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs"
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
            <input className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. narrator-2" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Transcript <span className="text-zinc-600">(exact words in the clip — auto-filled by transcription)</span>
            </label>
            <textarea
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm min-h-[64px]"
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
          <input
            className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm"
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            title="text used for the saved-voice preview below"
          />
        </div>
      </div>

      {/* ---------- saved voices ---------- */}
      <div className="space-y-2">
        {voices.length === 0 && <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-zinc-400">No voices yet. Prepare one above — the transcript makes cloning noticeably better.</div>}
        {voices.map((v) => (
          <div key={v.id} className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="font-medium">{v.name}</div>
              <div className="text-sm text-zinc-500 truncate">{v.reference_text || 'no transcript'}</div>
            </div>
            <Button onClick={() => preview(v.id)} disabled={previewingId === v.id}>
              {previewingId === v.id ? 'generating…' : '▶ preview'}
            </Button>
            <Button variant="ghost" onClick={() => void new Audio(api.audioUrl.voice(v.id)).play()} title="hear the original reference">
              🔊 ref
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api.deleteVoice(v.id);
                refresh();
              }}
            >
              delete
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

// selection hint readout (updated by wavesurfer region events)
let selectionText: string | null = null;
