import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { paths } from './config.js';

export type BookStatus = 'draft' | 'queued' | 'generating' | 'paused' | 'done';
export type ChunkStatus = 'pending' | 'generating' | 'done' | 'failed';

export interface BookRow {
  id: string;
  title: string;
  author: string;
  language: string;
  cover_path: string | null;
  source_file: string;
  status: BookStatus;
  voice_id: string | null;
  max_chunk_chars: number;
  num_inference_steps: number;
  guidance_scale: number;
  speed: number;
  seed: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterRow {
  id: string;
  book_id: string;
  idx: number;
  title: string;
  char_count: number;
}

export interface ChunkRow {
  id: string;
  book_id: string;
  chapter_id: string;
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
  status: ChunkStatus;
  audio_path: string | null;
  duration_ms: number | null;
  error: string | null;
  attempts: number;
}

export interface VoiceRow {
  id: string;
  name: string;
  wav_path: string;
  reference_text: string;
  created_at: string;
}

export interface JobRow {
  id: string;
  book_id: string;
  state: 'running' | 'paused' | 'done' | 'canceled';
  total_chunks: number;
  done_chunks: number;
  failed_chunks: number;
  created_at: string;
}

const MIGRATIONS: string[] = [
  // 001 — initial schema
  `
  CREATE TABLE books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    cover_path TEXT,
    source_file TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    voice_id TEXT,
    max_chunk_chars INTEGER NOT NULL DEFAULT 280,
    num_inference_steps INTEGER NOT NULL DEFAULT 32,
    guidance_scale REAL NOT NULL DEFAULT 2.0,
    speed REAL NOT NULL DEFAULT 1.0,
    seed TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    audio_path TEXT,
    duration_ms INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_chunks_book ON chunks(book_id, chapter_id, idx);
  CREATE INDEX idx_chunks_status ON chunks(status);
  CREATE TABLE voices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    wav_path TEXT NOT NULL,
    reference_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'running',
    total_chunks INTEGER NOT NULL DEFAULT 0,
    done_chunks INTEGER NOT NULL DEFAULT 0,
    failed_chunks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE exports (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    path TEXT NOT NULL,
    chapter_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  `,
  // 002 — job timing stats (generation rate / ETA)
  `
  ALTER TABLE jobs ADD COLUMN started_at TEXT;
  ALTER TABLE jobs ADD COLUMN finished_at TEXT;
  ALTER TABLE jobs ADD COLUMN audio_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN wall_ms INTEGER NOT NULL DEFAULT 0;
  `,
];

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(paths.data, { recursive: true });
  db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number((r as { version: number }).version)),
  );
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.exec('BEGIN;');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });
}

export function closeDb(): void {
  db?.close();
  db = null;
}
