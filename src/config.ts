import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Project root: works when running from source (src/) and compiled (dist/src/)
 * by walking up to the directory containing package.json.
 *
 * AUDIOBOOK_STUDIO_HOME overrides it so a read-only installation (e.g. the Nix
 * store) keeps data/, runtime/ and versions.json in a writable state dir.
 */
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const root = process.env.AUDIOBOOK_STUDIO_HOME
  ? path.resolve(process.env.AUDIOBOOK_STUDIO_HOME)
  : findRoot(path.dirname(fileURLToPath(import.meta.url)));

export type AppSettings = {
  /** 'managed' = studio spawns its bundled audio.cpp runtime (standalone);
   *  'external' = point at an already-running audio.cpp server. */
  ttsMode: 'managed' | 'external';
  /** Port for the managed TTS server child process. */
  managedPort: number;
  /** Base URL of an external audio.cpp server (no trailing slash, no /v1). */
  audiocppUrl: string;
  /** Model id as configured in the audio.cpp server config. */
  model: string;
  /** Parallel requests to audio.cpp (server queues beyond 1 per model). */
  concurrency: number;
  /** ffmpeg binary; 'ffmpeg' = use PATH. */
  ffmpegPath: string;
  /** Default chunk size (characters) for new books. */
  defaultMaxChunkChars: number;
  /** Server port for this app. */
  port: number;
  /** Smooth chunk joins during assembly (edge trim + loudness match + fades + pauses). */
  assemblySmooth: boolean;
  /** Inserted pause between chunks at sentence boundaries (ms). */
  assemblyGapMs: number;
  /** Inserted pause at paragraph boundaries (ms). */
  assemblyParagraphGapMs: number;
  /** Inserted pause at mid-sentence (soft cut) chunk boundaries (ms). */
  assemblySoftCutGapMs: number;
};

const defaults: AppSettings = {
  ttsMode: 'managed',
  managedPort: 8081,
  audiocppUrl: 'http://127.0.0.1:8080',
  model: 'omnivoice',
  concurrency: 1,
  ffmpegPath: 'ffmpeg',
  defaultMaxChunkChars: 280,
  port: 8090,
  assemblySmooth: true,
  assemblyGapMs: 400,
  assemblyParagraphGapMs: 700,
  assemblySoftCutGapMs: 120,
};

export const paths = {
  root,
  data: path.join(root, 'data'),
  books: path.join(root, 'data', 'books'),
  voices: path.join(root, 'data', 'voices'),
  voicesTakes: path.join(root, 'data', 'voices-takes'),
  exports: path.join(root, 'data', 'exports'),
  runtime: path.join(root, 'runtime'),
  db: path.join(root, 'data', 'studio.db'),
  serverLog: path.join(root, 'data', 'server.log'),
};

export function ensureDirs(): void {
  for (const dir of [paths.data, paths.books, paths.voices, paths.voicesTakes, paths.exports]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Settings come from data/settings.json (created on first run) with sane
 * defaults; every write re-serializes so users can hand-edit too.
 */
export function loadSettings(): AppSettings {
  ensureDirs();
  const file = path.join(paths.data, 'settings.json');
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppSettings>;
  } catch {
    // first run or user edit broke JSON — fall back to defaults
  }
  return { ...defaults, ...stored };
}

export function saveSettings(settings: AppSettings): void {
  const file = path.join(paths.data, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
}
