import { useEffect, useState } from 'react';
import { api, type Health, type Settings as SettingsType } from '../lib/api';
import { Button } from '../components/bits';

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(String(e.message ?? e)));
    api.health().then(setHealth).catch((e) => setHealth({ ok: false, error: String(e.message ?? e) }));
  }, []);

  const save = async () => {
    if (!settings) return;
    setError('');
    try {
      setSettings(await api.putSettings(settings));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      api.health().then(setHealth).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!settings) return <div className="text-zinc-400">{error || 'Loading…'}</div>;

  const field = (label: string, key: keyof SettingsType, hint?: string) => (
    <div className="mb-3">
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input
        className="w-full max-w-lg rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm"
        value={String(settings[key])}
        onChange={(e) => setSettings({ ...settings, [key]: key === 'concurrency' || key === 'defaultMaxChunkChars' || key === 'port' ? Number(e.target.value) : e.target.value })}
      />
      {hint && <div className="text-[11px] text-zinc-600 mt-0.5">{hint}</div>}
    </div>
  );

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Settings</h1>
      {error && <div className="mb-4 rounded-lg bg-red-950 border border-red-800 text-red-200 px-4 py-2 text-sm">{error}</div>}

      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 mb-6">
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-zinc-400">audio.cpp server:</span>
          {health?.ok ? (
            <span className="text-emerald-400">
              ● online — backend {health.audiocpp?.backend ?? '?'} · {health.audiocpp?.models ?? '?'} model(s) · v{health.audiocpp?.version ?? '?'}
            </span>
          ) : (
            <span className="text-red-400">● offline — {health?.error ?? 'unreachable'}</span>
          )}
        </div>
        {field('audio.cpp base URL', 'audiocppUrl', 'no /v1 suffix — e.g. http://127.0.0.1:8080')}
        {field('Model id', 'model', 'the "id" from the audio.cpp server.json models[] list')}
        {field('Concurrency', 'concurrency', 'parallel requests to audio.cpp (1 = sequential; the server queues anyway)')}
        {field('ffmpeg path', 'ffmpegPath', "'ffmpeg' = use PATH")}
        {field('Default chunk size (chars)', 'defaultMaxChunkChars', 'applies to newly added books')}
        {field('Studio port', 'port', 'requires restart')}
        <div className="flex items-center gap-3 mt-2">
          <Button variant="primary" onClick={save}>Save</Button>
          {saved && <span className="text-sm text-emerald-400">saved</span>}
        </div>
      </div>

      <div className="rounded-xl bg-zinc-900/60 border border-zinc-800 p-4 text-sm text-zinc-400">
        <p className="mb-2">
          <strong className="text-zinc-200">How synthesis works:</strong> each chunk is sent to your audio.cpp server as{' '}
          <code className="text-zinc-300">POST /v1/audio/speech</code> with the book's voice as an inline base64 reference —
          no changes to the audio.cpp config needed.
        </p>
        <p>
          The GPU stays on your Vulkan audio.cpp server; this app only orchestrates. Polish works out of the box with
          OmniVoice's automatic language detection, or set a language per book later.
        </p>
      </div>
    </div>
  );
}
