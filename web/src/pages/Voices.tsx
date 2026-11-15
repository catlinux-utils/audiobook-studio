import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onStudioEvent, type Voice } from '../lib/api';
import { Button } from '../components/bits';

export default function Voices() {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [name, setName] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const [previewText, setPreviewText] = useState('To jest krótki przykład głosu. Dzień dobry, witaj w audiobookach.');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.listVoices().then(setVoices).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    return onStudioEvent((ev) => {
      if (ev.type === 'voices.update') refresh();
    });
  }, [refresh]);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || !name.trim()) {
      setError('voice needs a name and a WAV file (a few seconds of clean speech)');
      return;
    }
    setUploading(true);
    setError('');
    try {
      await api.uploadVoice(name.trim(), referenceText.trim(), file);
      setName('');
      setReferenceText('');
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
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

      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 mb-6">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-3">Add voice (voice cloning reference)</h2>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-3 items-start">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Name</label>
            <input className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. narrator-male" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Reference transcript <span className="text-zinc-600">(exact words spoken in the WAV — big quality boost)</span>
            </label>
            <input className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm" value={referenceText} onChange={(e) => setReferenceText(e.target.value)} placeholder="Transcript of the reference audio…" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Reference WAV (≤3.5 MB)</label>
            <div className="flex gap-2">
              <input ref={fileRef} type="file" accept=".wav" className="text-sm file:mr-2 file:rounded file:border-0 file:bg-zinc-700 file:px-2 file:py-1 file:text-zinc-200" />
              <Button variant="primary" disabled={uploading} onClick={upload}>
                {uploading ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs text-zinc-400 mb-1">Preview text</label>
          <input className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm" value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        {voices.length === 0 && <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-zinc-400">No voices yet. Upload a short WAV of the voice you want to clone — its transcript makes cloning noticeably better.</div>}
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
