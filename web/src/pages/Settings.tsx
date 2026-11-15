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
    const poll = () => api.health().then(setHealth).catch((e) => setHealth({ ok: false, error: String(e.message ?? e) }));
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
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
          <span className="text-zinc-400">TTS server:</span>
          {health?.ok ? (
            <span className="text-emerald-400">
              ● online ({health.mode}) — backend {health.audiocpp?.backend ?? '?'} · {health.audiocpp?.models ?? '?'} model(s) · v{health.audiocpp?.version ?? '?'}
            </span>
          ) : (
            <span className="text-red-400">● offline — {health?.error ?? 'unreachable'}</span>
          )}
        </div>
        <div className="mb-3">
          <label className="block text-xs text-zinc-400 mb-1">TTS mode</label>
          <select
            className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm"
            value={settings.ttsMode}
            onChange={(e) => setSettings({ ...settings, ttsMode: e.target.value as 'managed' | 'external' })}
          >
            <option value="managed">managed — bundled audio.cpp runtime (standalone)</option>
            <option value="external">external — connect to a running audio.cpp server</option>
          </select>
          <div className="text-[11px] text-zinc-600 mt-0.5">
            managed mode starts the bundled Vulkan runtime automatically; install it once with setup.ps1 / setup.sh
          </div>
        </div>
        {settings.ttsMode === 'managed' && field('Managed TTS port', 'managedPort', 'the studio starts audio.cpp on this port (default 8081)')}
        {settings.ttsMode === 'external' && field('audio.cpp base URL', 'audiocppUrl', 'no /v1 suffix — e.g. http://127.0.0.1:8080')}
        {field('Model id', 'model', settings.ttsMode === 'managed' ? 'fixed by the managed config (omnivoice)' : 'the "id" from the audio.cpp server.json models[] list')}
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
