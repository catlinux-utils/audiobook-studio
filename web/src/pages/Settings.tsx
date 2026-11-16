import { useCallback, useEffect, useState } from 'react';
import { api, type Health, type Settings as SettingsType } from '../lib/api';
import { Banner, Button, Card, Checkbox, Input, SectionTitle, Select } from '../components/bits';

/** settings keys that must be sent to the API as numbers, not strings */
const NUM_KEYS = new Set<keyof SettingsType>([
  'managedPort',
  'concurrency',
  'defaultMaxChunkChars',
  'port',
  'assemblyGapMs',
  'assemblyParagraphGapMs',
  'assemblySoftCutGapMs',
]);

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [cacheResult, setCacheResult] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [log, setLog] = useState<{ lines: string[]; truncated: boolean } | null>(null);
  const [logBusy, setLogBusy] = useState(false);

  const clearAssemblyCache = async () => {
    setError('');
    try {
      const r = await api.clearAssemblyCache();
      setCacheResult(`removed ${r.dirsRemoved} cache folder(s), freed ${(r.bytesFreed / 1024 / 1024).toFixed(1)} MB`);
      setTimeout(() => setCacheResult(''), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const poll = useCallback(() => api.health().then(setHealth).catch((e) => setHealth({ ok: false, error: String(e.message ?? e) })), []);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(String(e.message ?? e)));
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [poll]);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const h = await api.health();
      setHealth(h);
      setTestResult(
        h.ok
          ? `connection OK — backend ${h.audiocpp?.backend ?? '?'} · ${h.audiocpp?.models ?? '?'} model(s) · v${h.audiocpp?.version ?? '?'}`
          : `connection failed — ${h.error ?? 'unreachable'}`,
      );
    } catch (e) {
      setTestResult(`connection failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const refreshLog = async () => {
    setLogBusy(true);
    try {
      setLog(await api.logsTail(200));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLogBusy(false);
    }
  };

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
      <Input
        className="w-full max-w-lg"
        value={String(settings[key])}
        onChange={(e) => setSettings({ ...settings, [key]: NUM_KEYS.has(key) ? Number(e.target.value) : e.target.value })}
      />
      {hint && <div className="text-[11px] text-zinc-600 mt-0.5">{hint}</div>}
    </div>
  );

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Settings</h1>
      {error && <Banner kind="error" className="mb-4">{error}</Banner>}

      <Card className="mb-6">
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-zinc-400">TTS server:</span>
          {health?.ok ? (
            <span className="text-emerald-400">
              ● online ({health.mode}) — backend {health.audiocpp?.backend ?? '?'} · {health.audiocpp?.models ?? '?'} model(s) · v{health.audiocpp?.version ?? '?'}
            </span>
          ) : (
            <span className="text-red-400">● offline — {health?.error ?? 'unreachable'}</span>
          )}
          <Button size="sm" onClick={testConnection} disabled={testing} title="check the audio.cpp server right now">
            {testing ? 'testing…' : '🔌 test connection'}
          </Button>
        </div>
        {testResult && <Banner kind={testResult.startsWith('connection OK') ? 'success' : 'error'} className="mb-3">{testResult}</Banner>}
        <div className="mb-3">
          <label className="block text-xs text-zinc-400 mb-1">TTS mode</label>
          <Select
            value={settings.ttsMode}
            onChange={(e) => setSettings({ ...settings, ttsMode: e.target.value as 'managed' | 'external' })}
          >
            <option value="managed">managed — bundled audio.cpp runtime (standalone)</option>
            <option value="external">external — connect to a running audio.cpp server</option>
          </Select>
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
        <SectionTitle className="mt-6 mb-3">Assembly</SectionTitle>
        <label className="flex items-center gap-2 mb-3 text-sm">
          <Checkbox
            checked={settings.assemblySmooth}
            onChange={(e) => setSettings({ ...settings, assemblySmooth: e.target.checked })}
          />
          <span className="text-zinc-300">Smooth chunk joins</span>
          <span className="text-[11px] text-zinc-600">— trim edge silence, loudness-match takes, micro-fades, consistent pauses</span>
        </label>
        {settings.assemblySmooth && (
          <>
            {field('Pause at sentences (ms)', 'assemblyGapMs', 'fallback pause target — used when the automatic per-chapter pause detection has nothing to measure (default 400)')}
            {field('Pause at paragraphs (ms)', 'assemblyParagraphGapMs', 'extra pause on top of the sentence pause at paragraph breaks (default 700)')}
            {field('Pause mid-sentence (ms)', 'assemblySoftCutGapMs', 'inserted where a long sentence was split across chunks (default 120)')}
          </>
        )}
        <div className="text-[11px] text-zinc-600 mb-3">
          Applies when building chapter audio and exports; chunk files themselves are never modified.
        </div>
        <div className="flex items-center gap-3 mt-2">
          <Button variant="primary" onClick={save}>Save</Button>
          {saved && <span className="text-sm text-emerald-400">saved</span>}
        </div>
      </Card>

      <Card title="Maintenance" className="mb-6">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <Button size="sm" onClick={clearAssemblyCache}>🧹 clear assembly caches</Button>
          <span className="text-xs text-zinc-500">
            removes the processed-copies cache (<code>.prep*</code> folders in book audio dirs) — they rebuild automatically on the
            next playback/export; chunk audio and books are never touched
          </span>
          {cacheResult && <span className="text-xs text-emerald-400">{cacheResult}</span>}
        </div>
      </Card>

      <Card title="Server log" className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Button size="sm" onClick={refreshLog} disabled={logBusy}>
            {logBusy ? 'reading…' : log ? '↺ refresh' : '📜 show recent log'}
          </Button>
          {log && <span className="text-xs text-zinc-500">last {log.lines.length} line(s) of data/server.log{log.truncated ? ' — older lines cut off' : ''}</span>}
        </div>
        {log && (
          <pre className="max-h-[360px] overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-xs leading-relaxed text-zinc-400 whitespace-pre-wrap">
            {log.lines.join('\n') || '(empty log)'}
          </pre>
        )}
      </Card>

      <Card className="bg-zinc-900/60! text-sm text-zinc-400">
        <p className="mb-2">
          <strong className="text-zinc-200">How synthesis works:</strong> each chunk is sent to your audio.cpp server as{' '}
          <code className="text-zinc-300">POST /v1/audio/speech</code> with the book's voice as an inline base64 reference —
          no changes to the audio.cpp config needed.
        </p>
        <p>
          The GPU stays on your Vulkan audio.cpp server; this app only orchestrates. Polish works out of the box with
          OmniVoice's automatic language detection, or set a language per book later.
        </p>
      </Card>
    </div>
  );
}
