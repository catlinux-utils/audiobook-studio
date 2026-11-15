import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Project root: works when running from source (src/) and compiled (dist/src/)
 * by walking up to the directory containing package.json.
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

const root = findRoot(path.dirname(fileURLToPath(import.meta.url)));

export type AppSettings = {
  /** Base URL of the audio.cpp server (no trailing slash, no /v1). */
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
};

const defaults: AppSettings = {
  audiocppUrl: 'http://127.0.0.1:8080',
  model: 'omnivoice',
  concurrency: 1,
  ffmpegPath: 'ffmpeg',
  defaultMaxChunkChars: 280,
  port: 8090,
};

export const paths = {
  root,
  data: path.join(root, 'data'),
  books: path.join(root, 'data', 'books'),
  voices: path.join(root, 'data', 'voices'),
  exports: path.join(root, 'data', 'exports'),
  db: path.join(root, 'data', 'studio.db'),
};

export function ensureDirs(): void {
  for (const dir of [paths.data, paths.books, paths.voices, paths.exports]) {
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
