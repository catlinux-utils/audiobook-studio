import type { FastifyInstance } from 'fastify';
import '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, type BookRow, type ChapterRow, type ChunkRow, type VoiceRow, type VoiceTakeRow } from '../db.js';
import { paths, loadSettings, saveSettings, type AppSettings } from '../config.js';
import { parseEpub } from '../ingest/epub.js';
import { splitTxtChapters } from '../ingest/txt.js';
import { chunkText } from '../ingest/chunker.js';
import { queue } from '../tts/queue.js';
import { AudioCppClient } from '../tts/audiocpp.js';
import { alignTranscript } from '../tts/align.js';
import { runFfmpeg, qaTake, type WordQa } from '../tts/qa.js';
import { sanitizeExpertOptions, expertOptionsToRequest, type ExpertOptions } from '../tts/voiceOptions.js';
import { applyVoiceCleanup, CLEANUP_MAX_BYTES, type CleanupOptions } from '../audio/voiceCleanup.js';
import { analyzeWav, suggestCleanup } from '../audio/analyze.js';
import { readWavInfo } from '../audio/wavmeta.js';
import { assembleChapter, exportM4b, exportChapterMp3 } from '../audio/assemble.js';
import { bus } from '../bus.js';
import { ttsBaseUrl } from '../tts/managed.js';
import { spawn } from 'node:child_process';

const MAX_VOICE_WAV_BYTES = 3.5 * 1024 * 1024; // inline voice_ref payloads are capped at 5 MiB base64

export function registerRoutes(app: FastifyInstance): void {
  // ---------- health ----------
  app.get('/api/health', async () => {
    const s = loadSettings();
    const client = new AudioCppClient(ttsBaseUrl(), s.model);
    try {
      const info = await client.health();
      return { ok: true, mode: s.ttsMode, audiocpp: info, settings: publicSettings(s) };
    } catch (err) {
      return { ok: false, mode: s.ttsMode, error: err instanceof Error ? err.message : String(err), settings: publicSettings(s) };
    }
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => publicSettings(loadSettings()));
  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Partial<AppSettings>;
    const current = loadSettings();
    const next: AppSettings = {
      ttsMode: body.ttsMode === 'external' || body.ttsMode === 'managed' ? body.ttsMode : current.ttsMode,
      managedPort: clampInt(body.managedPort ?? current.managedPort, 1, 65535),
      audiocppUrl: (body.audiocppUrl ?? current.audiocppUrl).replace(/\/+$/, ''),
      model: body.model ?? current.model,
      concurrency: clampInt(body.concurrency ?? current.concurrency, 1, 8),
      ffmpegPath: body.ffmpegPath ?? current.ffmpegPath,
      defaultMaxChunkChars: clampInt(body.defaultMaxChunkChars ?? current.defaultMaxChunkChars, 60, 2000),
      port: clampInt(body.port ?? current.port, 1, 65535),
    };
    saveSettings(next);
    return publicSettings(next);
  });

  // ---------- stats ----------
  app.get('/api/stats', async () => {
    const db = getDb();
    const lifetime = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM books) AS books,
           (SELECT COUNT(*) FROM chunks WHERE status='done') AS chunks_done,
           (SELECT COUNT(*) FROM chunks WHERE status='failed') AS chunks_failed,
           (SELECT COALESCE(SUM(duration_ms),0) FROM chunks WHERE status='done') AS audio_ms`,
      )
      .get() as unknown as { books: number; chunks_done: number; chunks_failed: number; audio_ms: number };

    type JobStat = {
      id: string; book_id: string; state: string; total_chunks: number; done_chunks: number;
      failed_chunks: number; audio_ms: number; wall_ms: number; started_at: string | null;
    };
    const allJobs = db
      .prepare(
        `SELECT j.*, b.title,
           (SELECT c.title FROM chapters c WHERE c.id=j.chapter_id) AS chapter_title
         FROM jobs j JOIN books b ON b.id=j.book_id
         WHERE j.audio_ms > 0 ORDER BY j.created_at DESC`,
      )
      .all() as unknown as Array<JobStat & { title: string; chapter_title: string | null }>;

    const now = Date.now();
    const jobStats = allJobs.map((j) => {
      const liveWall = j.wall_ms + (j.started_at ? now - Date.parse(j.started_at) : 0);
      const speed = liveWall > 0 ? j.audio_ms / liveWall : 0; // × realtime
      const remaining = Math.max(0, j.total_chunks - j.done_chunks);
      const avgChunkAudio = j.done_chunks > 0 ? j.audio_ms / j.done_chunks : 0;
      const etaMs = j.state === 'running' && speed > 0 && remaining > 0
        ? Math.round((remaining * avgChunkAudio) / speed)
        : null;
      return {
        jobId: j.id,
        bookId: j.book_id,
        title: j.title,
        chapterTitle: j.chapter_title ?? undefined,
        state: j.state,
        done: j.done_chunks,
        total: j.total_chunks,
        failed: j.failed_chunks,
        audioMs: j.audio_ms,
        wallMs: liveWall,
        speedFactor: Math.round(speed * 100) / 100,
        etaMs,
      };
    });

    const genWallMs = jobStats.reduce((a, j) => a + j.wallMs, 0);
    const genAudioMs = jobStats.reduce((a, j) => a + j.audioMs, 0);

    // priority regenerations (not jobs) — shown as their own activity rows
    const regens = queue.getRegenActivity().map((r) => {
      const info = db
        .prepare(
          `SELECT k.idx AS chunk_idx, c.title AS chapter_title, c.idx AS chapter_idx, b.title AS book_title
           FROM chunks k JOIN chapters c ON c.id=k.chapter_id JOIN books b ON b.id=k.book_id
           WHERE k.id=?`,
        )
        .get(r.chunkId) as unknown as
        | { chunk_idx: number; chapter_title: string; chapter_idx: number; book_title: string }
        | undefined;
      return {
        ...r,
        chunkIdx: (info?.chunk_idx ?? 0) + 1,
        chapterTitle: info?.chapter_title ?? '',
        chapterIdx: (info?.chapter_idx ?? 0) + 1,
        bookTitle: info?.book_title ?? '',
      };
    });

    return {
      lifetime: {
        ...lifetime,
        genWallMs,
        speedFactor: genWallMs > 0 ? Math.round((genAudioMs / genWallMs) * 100) / 100 : null,
      },
      jobs: jobStats,
      regens,
    };
  });

  // ---------- books ----------
  app.get('/api/books', async () => {
    const db = getDb();
    const books = db
      .prepare(
        `SELECT b.*,
           (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapter_count,
           (SELECT COUNT(*) FROM chunks k WHERE k.book_id=b.id) AS chunk_count,
           (SELECT COUNT(*) FROM chunks k WHERE k.book_id=b.id AND k.status='done') AS chunks_done,
           (SELECT COUNT(*) FROM chunks k WHERE k.book_id=b.id AND k.status='failed') AS chunks_failed,
           (SELECT COALESCE(SUM(k.duration_ms),0) FROM chunks k WHERE k.book_id=b.id AND k.status='done') AS duration_ms,
           (SELECT v.name FROM voices v WHERE v.id=b.voice_id) AS voice_name
         FROM books b ORDER BY b.created_at DESC`,
      )
      .all() as unknown as BookSummary[];
    return books;
  });

  app.post('/api/books', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 200 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'multipart file field required' });
    const buf = await file.toBuffer();
    const ext = path.extname(file.filename || '').toLowerCase();

    let parsed: { title: string; author: string; language: string; chapters: Array<{ title: string; text: string }>; cover: { data: Uint8Array; mime: string } | null };
    try {
      if (ext === '.epub') {
        parsed = parseEpub(new Uint8Array(buf));
      } else if (ext === '.txt') {
        const raw = buf.toString('utf8');
        const chapters = splitTxtChapters(raw);
        const firstLine = raw.split('\n').find((l) => l.trim()) ?? 'Unknown title';
        parsed = { title: firstLine.trim().slice(0, 120), author: '', language: '', chapters, cover: null };
      } else {
        return reply.code(400).send({ error: 'unsupported file type — use .epub or .txt' });
      }
    } catch (err) {
      return reply.code(422).send({ error: `ingest failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    const s = loadSettings();
    const bookId = randomUUID();
    const bookDir = path.join(paths.books, bookId);
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, 'source' + (ext || '.txt')), buf);

    let coverPath: string | null = null;
    if (parsed.cover) {
      const coverExt = parsed.cover.mime.includes('png') ? '.png' : '.jpg';
      coverPath = path.join(bookDir, `cover${coverExt}`);
      fs.writeFileSync(coverPath, parsed.cover.data);
    }

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO books (id, title, author, language, cover_path, source_file, status, max_chunk_chars, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(bookId, parsed.title, parsed.author, parsed.language, coverPath, file.filename ?? '', 'draft', s.defaultMaxChunkChars, now, now);

    insertChaptersAndChunks(bookId, parsed.chapters, s.defaultMaxChunkChars);
    bus.emit('event', { type: 'book.update', bookId, status: 'draft' });
    return { id: bookId };
  });

  /**
   * Paste a short text (story / article) as a one-chapter draft book — same
   * pipeline as ingested books (chunks, queue, exports, QA), no file needed.
   */
  app.post('/api/books/paste', async (req, reply) => {
    const body = (req.body ?? {}) as { title?: string; author?: string; language?: string; text?: string; voiceId?: string };
    const text = (body.text ?? '').replace(/\r\n/g, '\n').trim();
    const title = (body.title ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (!title) return reply.code(400).send({ error: 'title is required' });
    if (text.length > 200_000) return reply.code(413).send({ error: 'text too long for a quick paste (max ~200k chars) — ingest a file instead' });

    const db = getDb();
    if (body.voiceId) {
      const voice = db.prepare('SELECT id FROM voices WHERE id=?').get(body.voiceId);
      if (!voice) return reply.code(422).send({ error: 'voice not found' });
    }

    const s = loadSettings();
    const bookId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO books (id, title, author, language, cover_path, source_file, status, voice_id, max_chunk_chars, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      bookId, title.slice(0, 120), (body.author ?? '').trim().slice(0, 120), (body.language ?? '').trim(),
      null, 'pasted', 'draft', body.voiceId || null, s.defaultMaxChunkChars, now, now,
    );
    // keep the text on disk so re-chunking works like for ingested books
    const bookDir = path.join(paths.books, bookId);
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, 'source.txt'), text);

    insertChaptersAndChunks(bookId, [{ title: 'Full text', text }], s.defaultMaxChunkChars);
    const chapter = db.prepare('SELECT id FROM chapters WHERE book_id=? ORDER BY idx LIMIT 1').get(bookId) as unknown as { id: string };
    const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE book_id=?').get(bookId) as unknown as { n: number }).n;
    bus.emit('event', { type: 'book.update', bookId, status: 'draft' });
    return { id: bookId, chapterId: chapter.id, chunkCount };
  });

  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    const chapters = db
      .prepare(
        `SELECT c.*, 
           (SELECT COUNT(*) FROM chunks k WHERE k.chapter_id=c.id) AS chunk_count,
           (SELECT COUNT(*) FROM chunks k WHERE k.chapter_id=c.id AND k.status='done') AS chunks_done,
           (SELECT COUNT(*) FROM chunks k WHERE k.chapter_id=c.id AND k.status='failed') AS chunks_failed,
           (SELECT COALESCE(SUM(k.duration_ms),0) FROM chunks k WHERE k.chapter_id=c.id AND k.status='done') AS duration_ms
         FROM chapters c WHERE c.book_id=? ORDER BY c.idx`,
      )
      .all(id) as unknown as ChapterSummary[];
    const voice = book.voice_id
      ? (db.prepare('SELECT id, name FROM voices WHERE id=?').get(book.voice_id) as unknown as { id: string; name: string } | undefined)
      : undefined;
    const job = db
      .prepare(
        `SELECT id, state, chapter_id, total_chunks, done_chunks, failed_chunks, audio_ms, wall_ms, started_at,
           (SELECT c.title FROM chapters c WHERE c.id=jobs.chapter_id) AS chapter_title
         FROM jobs WHERE book_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id) as unknown as
      | {
          id: string;
          state: string;
          chapter_id: string | null;
          total_chunks: number;
          done_chunks: number;
          failed_chunks: number;
          audio_ms: number;
          wall_ms: number;
          started_at: string | null;
          chapter_title: string | null;
        }
      | undefined;
    let jobStats: {
      state: string;
      done: number;
      total: number;
      failed: number;
      audioMs: number;
      wallMs: number;
      speedFactor: number | null;
      etaMs: number | null;
      chapterTitle?: string;
    } | null = null;
    if (job && job.audio_ms > 0) {
      // progress is scoped to the job's chapter when it is a chapter job
      const scope = job.chapter_id ? 'AND k.chapter_id=?' : '';
      const scopeArgs: Array<string> = job.chapter_id ? [job.chapter_id] : [];
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM chunks k WHERE k.book_id=? ${scope}) AS total,
             (SELECT COUNT(*) FROM chunks k WHERE k.book_id=? ${scope} AND k.status='done') AS done,
             (SELECT COUNT(*) FROM chunks k WHERE k.book_id=? ${scope} AND k.status='failed') AS failed`,
        )
        .get(id, ...scopeArgs, id, ...scopeArgs, id, ...scopeArgs) as unknown as {
        total: number;
        done: number;
        failed: number;
      };
      const liveWall = job.wall_ms + (job.started_at ? Date.now() - Date.parse(job.started_at) : 0);
      const speed = liveWall > 0 ? job.audio_ms / liveWall : 0;
      const remaining = Math.max(0, counts.total - counts.done);
      const avgChunkAudio = counts.done > 0 ? job.audio_ms / counts.done : 0;
      jobStats = {
        state: job.state,
        done: counts.done,
        total: counts.total,
        failed: counts.failed,
        audioMs: job.audio_ms,
        wallMs: liveWall,
        speedFactor: speed > 0 ? Math.round(speed * 100) / 100 : null,
        etaMs: job.state === 'running' && speed > 0 && remaining > 0 ? Math.round((remaining * avgChunkAudio) / speed) : null,
        ...(job.chapter_title ? { chapterTitle: job.chapter_title } : {}),
      };
    }
    return { ...book, voice: voice ?? null, job: jobStats, chapters };
  });

  app.get('/api/books/:id/cover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = getDb().prepare('SELECT cover_path FROM books WHERE id=?').get(id) as unknown as
      | { cover_path: string | null }
      | undefined;
    if (!book?.cover_path || !fs.existsSync(book.cover_path)) return reply.code(404).send({ error: 'no cover' });
    const mime = book.cover_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return reply.type(mime).send(fs.createReadStream(book.cover_path));
  });

  app.get('/api/books/:id/chapters/:chapterId', async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const db = getDb();
    const chapter = db
      .prepare('SELECT * FROM chapters WHERE id=? AND book_id=?')
      .get(chapterId, id) as unknown as ChapterRow | undefined;
    if (!chapter) return reply.code(404).send({ error: 'chapter not found' });
    const chunks = db
      .prepare('SELECT id, idx, text, char_start, char_end, status, duration_ms, error, attempts FROM chunks WHERE chapter_id=? ORDER BY idx')
      .all(chapterId) as unknown as ChunkRow[];
    return { chapter, chunks };
  });

  app.patch('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    const body = (req.body ?? {}) as Record<string, unknown>;

    const next: Partial<BookRow> = {};
    if (body.voiceId !== undefined) next.voice_id = body.voiceId === null ? null : String(body.voiceId);
    if (body.title !== undefined) next.title = String(body.title).slice(0, 200);
    if (body.author !== undefined) next.author = String(body.author).slice(0, 200);
    if (body.numInferenceSteps !== undefined) next.num_inference_steps = clampInt(Number(body.numInferenceSteps), 1, 128);
    if (body.guidanceScale !== undefined) next.guidance_scale = clampNum(Number(body.guidanceScale), 0, 10);
    if (body.speed !== undefined) next.speed = clampNum(Number(body.speed), 0.5, 2);
    if (body.seed !== undefined) next.seed = body.seed === null || body.seed === '' ? null : String(body.seed);

    // changing chunk size invalidates existing chunks — require explicit rechunk
    if (body.maxChunkChars !== undefined && Number(body.maxChunkChars) !== book.max_chunk_chars) {
      const generated = db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id=? AND status IN ('done','generating')")
        .get(id) as unknown as { n: number };
      if (generated.n > 0 && body.force !== true) {
        return reply.code(409).send({ error: 'book already has generated audio; call /rechunk to rebuild text chunks' });
      }
      next.max_chunk_chars = clampInt(Number(body.maxChunkChars), 60, 2000);
      if (next.max_chunk_chars !== book.max_chunk_chars) rechunkBook(id, next.max_chunk_chars);
    }

    const keys = Object.keys(next);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k}=?`).join(', ');
      const values = keys.map((k): string | number | null => {
        const v = (next as Record<string, unknown>)[k];
        return v === null ? null : typeof v === 'number' ? v : String(v);
      });
      db.prepare(`UPDATE books SET ${sets}, updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), id);
      bus.emit('event', { type: 'book.update', bookId: id, status: 'meta' });
    }
    return getBookPayload(id);
  });

  app.delete('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    queue.cancelBook(id);
    const db = getDb();
    db.prepare('DELETE FROM books WHERE id=?').run(id);
    fs.rmSync(path.join(paths.books, id), { recursive: true, force: true });
    bus.emit('event', { type: 'book.update', bookId: id, status: 'deleted' });
    return { ok: true };
  });

  app.patch('/api/books/:id/chapters/:chapterId', async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const body = (req.body ?? {}) as { title?: string };
    if (body.title === undefined) return reply.code(400).send({ error: 'title is required' });
    const title = String(body.title).trim().slice(0, 200);
    if (!title) return reply.code(400).send({ error: 'title cannot be empty' });
    const db = getDb();
    const result = db
      .prepare('UPDATE chapters SET title=? WHERE id=? AND book_id=?')
      .run(title, chapterId, id);
    if (result.changes === 0) return reply.code(404).send({ error: 'chapter not found' });
    bus.emit('event', { type: 'book.update', bookId: id, status: 'meta' });
    return { id: chapterId, title };
  });

  /**
   * Replace a chapter's text: re-splits it into fresh parts (book's chunk
   * size). Generated audio of this chapter is dropped — the text no longer
   * matches it. Refuses while parts are mid-generation.
   */
  app.put('/api/books/:id/chapters/:chapterId/text', async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (text.length > 400_000) return reply.code(413).send({ error: 'text too long (max ~400k chars)' });
    const db = getDb();
    const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND book_id=?').get(chapterId, id) as unknown as ChapterRow | undefined;
    if (!chapter) return reply.code(404).send({ error: 'chapter not found' });
    const generating = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE chapter_id=? AND status='generating'")
      .get(chapterId) as unknown as { n: number };
    if (generating.n > 0) return reply.code(409).send({ error: 'parts of this chapter are generating right now — pause or wait first' });

    const olds = db.prepare('SELECT audio_path FROM chunks WHERE chapter_id=?').all(chapterId) as unknown as Array<{ audio_path: string | null }>;
    for (const o of olds) if (o.audio_path) fs.rmSync(o.audio_path, { force: true });
    db.prepare('DELETE FROM chunks WHERE chapter_id=?').run(chapterId);

    const book = db.prepare('SELECT max_chunk_chars FROM books WHERE id=?').get(id) as unknown as { max_chunk_chars: number };
    const chunkCount = rechunkChapterText(chapterId, id, text, book.max_chunk_chars);
    queue.refreshBookStatus(id);
    bus.emit('event', { type: 'book.update', bookId: id });
    return { ok: true, chunkCount };
  });

  app.post('/api/books/:id/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    if (!book.voice_id) return reply.code(400).send({ error: 'assign a voice first' });
    const result = queue.startBook(id);
    if ('error' in result) return reply.code(409).send(result);
    return result;
  });

  /** Generate only the given chapter's pending chunks (a chapter-scoped job). */
  app.post('/api/books/:id/chapters/:chapterId/generate', async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    if (!book.voice_id) return reply.code(400).send({ error: 'assign a voice first' });
    const chapter = db
      .prepare('SELECT id FROM chapters WHERE id=? AND book_id=?')
      .get(chapterId, id) as unknown as { id: string } | undefined;
    if (!chapter) return reply.code(404).send({ error: 'chapter not found' });
    const result = queue.startBook(id, chapterId);
    if ('error' in result) return reply.code(409).send(result);
    return result;
  });
  /** Queue an explicit selection of chunks (user-picked parts) as one job. */
  app.post('/api/books/:id/queue-chunks', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    if (!book.voice_id) return reply.code(400).send({ error: 'assign a voice first' });
    const body = (req.body ?? {}) as { chunkIds?: unknown };
    const chunkIds = Array.isArray(body.chunkIds) ? body.chunkIds.map(String) : [];
    if (chunkIds.length === 0) return reply.code(400).send({ error: 'chunkIds is required' });
    const result = queue.startChunks(id, chunkIds);
    if ('error' in result) return reply.code(409).send(result);
    return result;
  });

  /**
   * Export everything generated in one chapter to a single MP3 — works on
   * partially generated chapters too (exports the parts that exist).
   */
  app.post('/api/books/:id/chapters/:chapterId/export', async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    const chapter = db
      .prepare('SELECT * FROM chapters WHERE id=? AND book_id=?')
      .get(chapterId, id) as unknown as ChapterRow | undefined;
    if (!chapter) return reply.code(404).send({ error: 'chapter not found' });
    const chunks = db
      .prepare("SELECT * FROM chunks WHERE chapter_id=? AND status='done' AND audio_path IS NOT NULL ORDER BY idx")
      .all(chapterId) as unknown as ChunkRow[];
    if (chunks.length === 0) return reply.code(409).send({ error: 'no generated audio in this chapter' });
    const total = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE chapter_id=?').get(chapterId) as unknown as { n: number };

    try {
      const assembled = await assembleChapter(chapterId, chunks.map((c) => c.audio_path!));
      fs.mkdirSync(paths.exports, { recursive: true });
      const safe = `${book.title} - ${chapter.title}`
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || chapterId;
      const out = path.join(paths.exports, `${safe}.mp3`);
      await exportChapterMp3(assembled.path, out);

      // word-check every exported part (cached verdicts reused) + sidecar report
      const language = book.language || undefined;
      const qaRows: Array<{ idx: number; qa: StoredQa }> = [];
      for (let i = 0; i < chunks.length; i++) {
        qaRows.push({ idx: i + 1, qa: await qaChunkWithCache(chunks[i]!, language) });
      }
      const qaSummary = writeQaReport(out, `${book.title} — ${chapter.title} (word check)`, qaRows);

      const record = {
        id: randomUUID(),
        book_id: id,
        format: 'mp3',
        path: out,
        chapter_count: 1,
        duration_ms: assembled.durationMs,
        created_at: new Date().toISOString(),
      };
      db.prepare('INSERT INTO exports (id, book_id, format, path, chapter_count, duration_ms, created_at, qa_summary) VALUES (?,?,?,?,?,?,?,?)').run(
        record.id, record.book_id, record.format, record.path, record.chapter_count, record.duration_ms, record.created_at,
        JSON.stringify(qaSummary),
      );
      bus.emit('event', { type: 'book.update', bookId: id, status: book.status });
      return { export: record, parts: chunks.length, total: total.n, qa: qaSummary };
    } catch (err) {
      return reply.code(500).send({ error: `chapter export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post('/api/books/:id/pause', async (req) => queue.pauseBook((req.params as { id: string }).id) ?? { ok: true });
  app.post('/api/books/:id/cancel', async (req) => queue.cancelBook((req.params as { id: string }).id) ?? { ok: true });

  app.post('/api/books/:id/rechunk', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    // rechunking deletes all chunk rows — never while a generation job is live
    const activeJob = db
      .prepare("SELECT id FROM jobs WHERE book_id=? AND state IN ('running','paused')")
      .get(id) as unknown as { id: string } | undefined;
    if (activeJob) return reply.code(409).send({ error: 'generation is active — pause or cancel it before rechunking' });
    try {
      rechunkBook(id, book.max_chunk_chars);
    } catch (err) {
      return reply.code(500).send({ error: `rechunk failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    bus.emit('event', { type: 'book.update', bookId: id, status: book.status });
    return getBookPayload(id);
  });

  // ---------- chapter audio / export ----------
  app.get('/api/books/:id/chapters/:chapterId/audio', async (req, reply) => {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const db = getDb();
    const chapter = db.prepare('SELECT * FROM chapters WHERE id=? AND book_id=?').get(chapterId, id) as
      | ChapterRow
      | undefined;
    if (!chapter) return reply.code(404).send({ error: 'chapter not found' });
    const chunks = db
      .prepare("SELECT audio_path FROM chunks WHERE chapter_id=? AND status='done' ORDER BY idx")
      .all(chapterId) as unknown as Array<{ audio_path: string | null }>;
    const pathsList = chunks.map((c) => c.audio_path).filter((p): p is string => Boolean(p));
    if (pathsList.length === 0) return reply.code(404).send({ error: 'no generated audio for this chapter' });
    const { path: wavPath } = await assembleChapter(chapterId, pathsList);
    return reply.type('audio/wav').send(fs.createReadStream(wavPath));
  });

  app.post('/api/books/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    const chapters = db.prepare('SELECT * FROM chapters WHERE book_id=? ORDER BY idx').all(id) as unknown as ChapterRow[];
    const assembled: Array<{ chapterId: string; title: string; chunkPaths: string[]; durationMs: number }> = [];
    for (const chapter of chapters) {
      const chunks = db
        .prepare("SELECT audio_path FROM chunks WHERE chapter_id=? AND status='done' ORDER BY idx")
        .all(chapter.id) as unknown as Array<{ audio_path: string | null }>;
      const chunkPaths = chunks.map((c) => c.audio_path).filter((p): p is string => Boolean(p));
      if (chunkPaths.length === 0) continue;
      const done = db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE chapter_id=? AND status='done'")
        .get(chapter.id) as unknown as { n: number };
      const total = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE chapter_id=?').get(chapter.id) as unknown as { n: number };
      if (done.n !== total.n) continue; // skip partially generated chapters
      const a = await assembleChapter(chapter.id, chunkPaths);
      assembled.push({ chapterId: chapter.id, title: chapter.title, chunkPaths, durationMs: a.durationMs });
    }
    if (assembled.length === 0) return reply.code(409).send({ error: 'no complete chapters to export' });
    try {
      const m4b = await exportM4b(id, { title: book.title, author: book.author }, assembled, book.cover_path);
      // word-check every exported part (cached verdicts reused) + sidecar report
      const language = book.language || undefined;
      const qaRows: Array<{ idx: number; chapterTitle?: string; qa: StoredQa }> = [];
      for (const a of assembled) {
        const chunks = db
          .prepare("SELECT * FROM chunks WHERE chapter_id=? AND status='done' AND audio_path IS NOT NULL ORDER BY idx")
          .all(a.chapterId) as unknown as ChunkRow[];
        for (const c of chunks) {
          qaRows.push({ idx: qaRows.length + 1, chapterTitle: a.title, qa: await qaChunkWithCache(c, language) });
        }
      }
      const qaSummary = writeQaReport(m4b.path, `${book.title} — word check (${assembled.length} chapters)`, qaRows);
      const record = { id: randomUUID(), book_id: id, format: 'm4b', path: m4b.path, chapter_count: assembled.length, duration_ms: m4b.durationMs, created_at: new Date().toISOString(), qa_summary: JSON.stringify(qaSummary) };
      db.prepare('INSERT INTO exports (id, book_id, format, path, chapter_count, duration_ms, created_at, qa_summary) VALUES (?,?,?,?,?,?,?,?)').run(
        record.id, record.book_id, record.format, record.path, record.chapter_count, record.duration_ms, record.created_at, record.qa_summary,
      );
      bus.emit('event', { type: 'book.update', bookId: id, status: book.status });
      return { export: record, qa: qaSummary };
    } catch (err) {
      return reply.code(500).send({ error: `export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get('/api/books/:id/exports', async (req) => {
    const { id } = req.params as { id: string };
    const rows = getDb()
      .prepare('SELECT id, format, path, chapter_count, duration_ms, created_at, qa_summary FROM exports WHERE book_id=? ORDER BY created_at DESC')
      .all(id) as unknown as Array<{ id: string; format: string; path: string; chapter_count: number; duration_ms: number; created_at: string; qa_summary: string | null }>;
    return rows.map((x) => ({ ...x, qaSummary: x.qa_summary ? JSON.parse(x.qa_summary) : null }));
  });

  /** The word-check report sidecar of an export. */
  app.get('/api/exports/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = getDb().prepare('SELECT path FROM exports WHERE id=?').get(id) as unknown as
      | { path: string }
      | undefined;
    const report = record ? record.path.replace(/\.(mp3|m4b)$/i, '') + '.qa.txt' : '';
    if (!record || !fs.existsSync(report)) return reply.code(404).send({ error: 'no QA report for this export' });
    // served as a minimal HTML page (not bare text/plain — some browsers don't
    // render raw text) so clicking "QA report" just shows it
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(path.basename(report))}</title></head>` +
      `<body style="margin:2rem;background:#111;color:#ddd;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;">` +
      esc(fs.readFileSync(report, 'utf8')) +
      `</body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/exports/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = getDb().prepare('SELECT * FROM exports WHERE id=?').get(id) as unknown as
      | { path: string; format: string }
      | undefined;
    if (!record || !fs.existsSync(record.path)) return reply.code(404).send({ error: 'export not found' });
    // filenames are Polish — header values must stay Latin-1, so send an ASCII
    // fallback plus the RFC 5987 UTF-8 form the browser prefers
    const name = path.basename(record.path);
    const asciiFallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
    const utf8Name = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return reply
      .type(record.format === 'm4b' ? 'audio/mp4' : 'audio/mpeg')
      .header('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`)
      .send(fs.createReadStream(record.path));
  });

  // ---------- global exports ----------

  /** All exports across all books (for the Exports tab). */
  app.get('/api/exports', async () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT e.id, e.book_id, e.format, e.path, e.chapter_count, e.duration_ms, e.created_at, e.qa_summary,
                b.title AS book_title
         FROM exports e JOIN books b ON b.id=e.book_id
         ORDER BY e.created_at DESC`,
      )
      .all() as unknown as Array<{
      id: string;
      book_id: string;
      format: string;
      path: string;
      chapter_count: number;
      duration_ms: number;
      created_at: string;
      qa_summary: string | null;
      book_title: string;
    }>;
    return rows.map((x) => ({
      id: x.id,
      bookId: x.book_id,
      bookTitle: x.book_title,
      format: x.format,
      path: x.path,
      chapterCount: x.chapter_count,
      durationMs: x.duration_ms,
      createdAt: x.created_at,
      qaSummary: x.qa_summary ? JSON.parse(x.qa_summary) : null,
      sizeBytes: fs.existsSync(x.path) ? fs.statSync(x.path).size : null,
    }));
  });

  /**
   * Re-encode an export to fit under a target size (e.g. Discord's upload
   * limit). Bitrate is derived from the duration; if even the 16 kbps floor
   * cannot reach the target the result is returned with fitsTarget=false.
   */
  app.post('/api/exports/:id/compress', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const record = db.prepare('SELECT * FROM exports WHERE id=?').get(id) as unknown as
      | { id: string; book_id: string; format: string; path: string; chapter_count: number; duration_ms: number; created_at: string; qa_summary: string | null }
      | undefined;
    if (!record) return reply.code(404).send({ error: 'export not found' });
    if (!fs.existsSync(record.path)) return reply.code(409).send({ error: 'export file is missing on disk' });
    const body = (req.body ?? {}) as { targetMB?: number };
    const targetMB = Math.max(1, Math.min(2000, Number(body.targetMB) || 20));
    const durationS = record.duration_ms / 1000;
    if (durationS <= 0) return reply.code(409).send({ error: 'unknown export duration' });

    const targetBytes = targetMB * 1024 * 1024 * 0.96; // container headroom
    let kbps = Math.floor((targetBytes * 8) / 1000 / durationS);
    const minKbps = 16;
    const fitsTarget = kbps >= minKbps;
    if (!fitsTarget) kbps = minKbps;

    const ext = path.extname(record.path).toLowerCase();
    const base = path.basename(record.path, ext);
    // keep the original filename — compressed copies live in a subfolder so
    // nothing collides with the full-quality export
    const outDir = path.join(paths.exports, 'compressed');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${base}${ext}`);
    if (ext === '.m4b') {
      // keep chapter markers + embedded cover; re-encode audio only
      await runFfmpeg([
        '-y', '-i', record.path,
        '-map', '0:a', '-map', '0:v?',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${kbps}k`,
        '-disposition:v:0', 'attached_pic',
        '-map_chapters', '0', '-map_metadata', '0',
        '-f', 'mp4', out,
      ]);
    } else {
      await runFfmpeg(['-y', '-i', record.path, '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, out]);
    }
    const sizeBytes = fs.statSync(out).size;
    // carry the QA report over so the compressed row keeps its report link
    const sourceReport = record.path.replace(/\.(mp3|m4b)$/i, '') + '.qa.txt';
    if (fs.existsSync(sourceReport)) {
      fs.copyFileSync(sourceReport, out.replace(/\.(mp3|m4b)$/i, '') + '.qa.txt');
    }

    // compressing the same export twice re-points at the existing row
    const existing = db.prepare('SELECT id FROM exports WHERE path=?').get(out) as unknown as { id: string } | undefined;
    let exportId: string;
    if (existing) {
      exportId = existing.id;
      db.prepare('UPDATE exports SET created_at=? WHERE id=?').run(new Date().toISOString(), exportId);
    } else {
      exportId = randomUUID();
      db.prepare('INSERT INTO exports (id, book_id, format, path, chapter_count, duration_ms, created_at, qa_summary) VALUES (?,?,?,?,?,?,?,?)').run(
        exportId, record.book_id, record.format, out, record.chapter_count, record.duration_ms, new Date().toISOString(), record.qa_summary,
      );
    }
    const bookStatus = (db.prepare('SELECT status FROM books WHERE id=?').get(record.book_id) as unknown as { status: string } | undefined)?.status ?? 'draft';
    bus.emit('event', { type: 'book.update', bookId: record.book_id, status: bookStatus });
    const row = db
      .prepare(
        `SELECT e.*, b.title AS book_title FROM exports e JOIN books b ON b.id=e.book_id WHERE e.id=?`,
      )
      .get(exportId) as unknown as { id: string; book_id: string; format: string; path: string; chapter_count: number; duration_ms: number; created_at: string; qa_summary: string | null; book_title: string };
    return {
      export: {
        id: row.id,
        bookId: row.book_id,
        bookTitle: row.book_title,
        format: row.format,
        path: row.path,
        chapterCount: row.chapter_count,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
        qaSummary: row.qa_summary ? JSON.parse(row.qa_summary) : null,
        sizeBytes,
      },
      bitrateKbps: kbps,
      fitsTarget,
      targetMB,
    };
  });

  /** Remove an export: the row, its file on disk, its QA report and any compressed copy. */
  app.delete('/api/exports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const record = db.prepare('SELECT book_id, path FROM exports WHERE id=?').get(id) as unknown as
      | { book_id: string; path: string }
      | undefined;
    if (!record) return reply.code(404).send({ error: 'export not found' });

    const insideExports = (p: string) => path.resolve(p).startsWith(path.resolve(paths.exports));
    const targets: Array<{ id: string; path: string }> = [{ id, path: record.path }];
    // the compressed copy of the same audio goes with it
    const base = path.basename(record.path);
    const all = db.prepare('SELECT id, path FROM exports').all() as unknown as Array<{ id: string; path: string }>;
    for (const row of all) {
      if (row.id !== id && path.basename(row.path) === base && targets.every((t) => t.id !== row.id)) {
        targets.push(row);
      }
    }

    for (const t of targets) {
      if (!insideExports(t.path)) continue; // never touch files outside exports/
      fs.rmSync(t.path, { force: true });
      fs.rmSync(t.path.replace(/\.(mp3|m4b)$/i, '') + '.qa.txt', { force: true });
      db.prepare('DELETE FROM exports WHERE id=?').run(t.id);
    }
    const status = (db.prepare('SELECT status FROM books WHERE id=?').get(record.book_id) as unknown as { status: string } | undefined)?.status;
    if (status) bus.emit('event', { type: 'book.update', bookId: record.book_id, status });
    return { ok: true, removed: targets.length };
  });

  // ---------- QA spot-check ----------
  app.post('/api/books/:id/qa/random', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const done = db
      .prepare(
        `SELECT k.id, k.book_id, k.chapter_id, k.idx, k.text, k.duration_ms, c.title AS chapter_title, c.idx AS chapter_idx
         FROM chunks k JOIN chapters c ON c.id=k.chapter_id
         WHERE k.book_id=? AND k.status='done' ORDER BY RANDOM() LIMIT 1`,
      )
      .get(id) as
      | { id: string; book_id: string; chapter_id: string; idx: number; text: string; duration_ms: number; chapter_title: string; chapter_idx: number }
      | undefined;
    if (!done) return reply.code(404).send({ error: 'no generated chunks yet' });
    const neighbors = neighborIds(done.id);
    return { ...done, prevChunkId: neighbors.prev, nextChunkId: neighbors.next };
  });

  // ---------- chunks ----------
  app.get('/api/chunks/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const chunk = db.prepare('SELECT audio_path FROM chunks WHERE id=?').get(id) as unknown as { audio_path: string | null } | undefined;
    if (!chunk?.audio_path || !fs.existsSync(chunk.audio_path)) return reply.code(404).send({ error: 'audio not generated' });
    return reply.type('audio/wav').send(fs.createReadStream(chunk.audio_path));
  });

  app.post('/api/chunks/:id/regenerate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { seed?: string };
    const result = await queue.regenerateChunk(id, body.seed || undefined);
    if ('error' in result) return reply.code(409).send(result);
    return { ok: true };
  });

  /** Edit a part's text. Audio generated for the old text is dropped (status → pending). */
  app.patch('/api/chunks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (text.length > 8000) return reply.code(413).send({ error: 'part text too long (max 8000 chars) — edit the chapter instead' });
    const db = getDb();
    const chunk = db.prepare('SELECT * FROM chunks WHERE id=?').get(id) as unknown as ChunkRow | undefined;
    if (!chunk) return reply.code(404).send({ error: 'chunk not found' });
    if (chunk.status === 'generating') return reply.code(409).send({ error: 'part is generating right now — wait or pause first' });
    if (text === chunk.text.trim()) return { ok: true, changed: false };

    if (chunk.audio_path) fs.rmSync(chunk.audio_path, { force: true });
    db.prepare(
      "UPDATE chunks SET text=?, char_end=char_start+?, status='pending', audio_path=NULL, duration_ms=NULL, error=NULL, qa=NULL WHERE id=?",
    ).run(text, text.length, id);
    db.prepare('UPDATE chapters SET char_count=(SELECT COALESCE(SUM(LENGTH(text)),0) FROM chunks WHERE chapter_id=?) WHERE id=?').run(
      chunk.chapter_id, chunk.chapter_id,
    );
    queue.refreshBookStatus(chunk.book_id);
    bus.emit('event', { type: 'chunk.update', bookId: chunk.book_id, chapterId: chunk.chapter_id, chunkId: id, status: 'pending', durationMs: null });
    bus.emit('event', { type: 'book.update', bookId: chunk.book_id });
    return { ok: true, changed: true };
  });

  /** Word-completeness check: transcribe the generated audio and diff against the chunk text. */
  app.post('/api/chunks/:id/qa', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const chunk = db.prepare('SELECT * FROM chunks WHERE id=?').get(id) as unknown as ChunkRow | undefined;
    if (!chunk) return reply.code(404).send({ error: 'chunk not found' });
    if (!chunk.audio_path || !fs.existsSync(chunk.audio_path)) {
      return reply.code(409).send({ error: 'chunk has no generated audio' });
    }
    const book = db.prepare('SELECT language FROM books WHERE id=?').get(chunk.book_id) as unknown as
      | { language: string }
      | undefined;

    try {
      // verdict is cached on the chunk (with its duration) so exports reuse it
      return await qaChunkWithCache(chunk, book?.language || undefined);
    } catch (err) {
      return reply.code(502).send({ error: `qa failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // ---------- voices ----------
  app.get('/api/voices', async () => {
    return getDb().prepare('SELECT id, name, reference_text, synth_options, created_at FROM voices ORDER BY name').all();
  });

  app.post('/api/voices', async (req, reply) => {
    const parts = req.parts({ limits: { fileSize: MAX_VOICE_WAV_BYTES } });
    let name = '';
    let referenceText = '';
    let wav: Buffer | null = null;
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'wav') {
        wav = await part.toBuffer();
      } else if (part.type === 'field') {
        if (part.fieldname === 'name') name = String(part.value).trim();
        if (part.fieldname === 'reference_text') referenceText = String(part.value).trim();
      }
    }
    if (!name) return reply.code(400).send({ error: 'name is required' });
    if (!wav) return reply.code(400).send({ error: 'wav file is required' });
    try {
      readWavInfo(wav); // throws if not a valid WAV
    } catch (err) {
      return reply.code(422).send({ error: `invalid WAV: ${err instanceof Error ? err.message : String(err)}` });
    }
    const db = getDb();
    const id = randomUUID();
    const file = path.join(paths.voices, `${id}.wav`);
    fs.writeFileSync(file, wav);
    try {
      db.prepare('INSERT INTO voices (id, name, wav_path, reference_text, created_at) VALUES (?,?,?,?,?)').run(
        id, name, file, referenceText, new Date().toISOString(),
      );
    } catch (err) {
      fs.rmSync(file, { force: true });
      return reply.code(409).send({ error: `voice name already exists: ${err instanceof Error ? err.message : String(err)}` });
    }
    bus.emit('event', { type: 'voices.update' });
    return { id, name };
  });

  app.patch('/api/voices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string; referenceText?: string; synthOptions?: unknown };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });

    const next: { name?: string; reference_text?: string; synth_options?: string | null } = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return reply.code(400).send({ error: 'name cannot be empty' });
      const dupe = db.prepare('SELECT id FROM voices WHERE name=? AND id<>?').get(name, id);
      if (dupe) return reply.code(409).send({ error: 'another voice already has this name' });
      next.name = name;
    }
    if (body.referenceText !== undefined) next.reference_text = String(body.referenceText).trim();
    if (body.synthOptions !== undefined) {
      if (body.synthOptions === null) {
        next.synth_options = null;
      } else {
        const { options, rejected } = sanitizeExpertOptions(body.synthOptions);
        if (rejected.length > 0) return reply.code(400).send({ error: `unknown option(s): ${rejected.join(', ')}` });
        next.synth_options = Object.keys(options).length > 0 ? JSON.stringify(options) : null;
      }
    }

    const keys = Object.keys(next);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k}=?`).join(', ');
      const values = keys.map((k) => String((next as Record<string, string>)[k]));
      db.prepare(`UPDATE voices SET ${sets} WHERE id=?`).run(...values, id);
      bus.emit('event', { type: 'voices.update' });
    }
    const row = db.prepare('SELECT id, name, reference_text, synth_options, created_at FROM voices WHERE id=?').get(id) as unknown as { synth_options: string | null };
    return { ...row, synthOptions: row.synth_options ? JSON.parse(row.synth_options) : null };
  });

  app.delete('/api/voices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    // remove experiment takes from disk before the cascade drops the rows
    const takes = db.prepare('SELECT wav_path FROM voice_takes WHERE voice_id=?').all(id) as unknown as Array<{ wav_path: string }>;
    for (const t of takes) fs.rmSync(t.wav_path, { force: true });
    db.prepare('DELETE FROM voices WHERE id=?').run(id);
    fs.rmSync(voice.wav_path, { force: true });
    bus.emit('event', { type: 'voices.update' });
    return { ok: true };
  });

  app.get('/api/voices/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const voice = db.prepare('SELECT wav_path FROM voices WHERE id=?').get(id) as unknown as { wav_path: string } | undefined;
    if (!voice || !fs.existsSync(voice.wav_path)) return reply.code(404).send({ error: 'voice not found' });
    return reply.type('audio/wav').send(fs.createReadStream(voice.wav_path));
  });

  app.post('/api/voices/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    const s = loadSettings();
    const client = new AudioCppClient(ttsBaseUrl(), s.model);
    try {
      const wav = await client.synthesize({
        input: (body.text || 'To jest krótki przykład głosu narratora.').slice(0, 300),
        voiceRefBase64: fs.readFileSync(voice.wav_path).toString('base64'),
        referenceText: voice.reference_text || undefined,
        numInferenceSteps: 24,
      });
      return reply.type('audio/wav').send(wav);
    } catch (err) {
      return reply.code(502).send({ error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // ---------- voice preparation & auto-transcript ----------

  /**
   * Prepare a reference clip for cloning: cut [start,end] (seconds), convert
   * to mono 24 kHz 16-bit WAV, optionally normalize loudness, trim edge
   * silence. Returns the processed WAV bytes (must stay <= 3.5 MiB for the
   * inline voice_ref payload).
   */
  app.post('/api/voices/prepare', async (req, reply) => {
    const parts = req.parts({ limits: { fileSize: 200 * 1024 * 1024 } });
    let fileBuf: Buffer | null = null;
    let fileName = 'input';
    let start = 0;
    let end: number | null = null;
    let normalize = true;
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') {
        fileBuf = await part.toBuffer();
        fileName = part.filename || fileName;
      } else if (part.type === 'field') {
        if (part.fieldname === 'start') start = Math.max(0, Number(part.value) || 0);
        if (part.fieldname === 'end' && part.value !== '') end = Math.max(0, Number(part.value));
        if (part.fieldname === 'normalize') normalize = part.value === 'true';
      }
    }
    if (!fileBuf) return reply.code(400).send({ error: 'file is required' });

    const tmpIn = path.join(paths.data, `prep-${randomUUID()}${path.extname(fileName) || '.audio'}`);
    const tmpOut = path.join(paths.data, `prep-${randomUUID()}.wav`);
    fs.writeFileSync(tmpIn, fileBuf);
    try {
      const filters = ['silenceremove=start_periods=1:start_threshold=-45dB'];
      if (normalize) filters.push('loudnorm=I=-20:TP=-1.5:LRA=7');
      const args = ['-y', '-i', tmpIn];
      if (end !== null && end > start) args.push('-ss', String(start), '-to', String(end));
      else if (start > 0) args.push('-ss', String(start));
      args.push('-af', filters.join(','), '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', tmpOut);
      await runFfmpeg(args);
      const wav = fs.readFileSync(tmpOut);
      if (wav.length > MAX_VOICE_WAV_BYTES) {
        return reply.code(422).send({
          error: `prepared clip is too long (${Math.round((wav.length - 44) / 48000)} s at 24 kHz); select a shorter region (max ~70 s)`,
        });
      }
      const info = readWavInfo(wav);
      return reply
        .type('audio/wav')
        .header('X-Prepared-Duration-Ms', String(info.durationMs))
        .send(wav);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      fs.rmSync(tmpIn, { force: true });
      fs.rmSync(tmpOut, { force: true });
    }
  });

  /** Auto-transcribe a (prepared) WAV via the managed CrisperWhisper ASR model. */
  app.post('/api/voices/transcribe', async (req, reply) => {
    const parts = req.parts({ limits: { fileSize: MAX_VOICE_WAV_BYTES * 2 } });
    let wav: Buffer | null = null;
    let language = '';
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') wav = await part.toBuffer();
      else if (part.type === 'field' && part.fieldname === 'language') language = String(part.value).trim();
    }
    if (!wav) return reply.code(400).send({ error: 'file is required' });
    try {
      readWavInfo(wav);
    } catch {
      return reply.code(422).send({ error: 'file must be a WAV (use the prepared clip)' });
    }

    const s = loadSettings();
    const tmp = path.join(paths.data, `asr-${randomUUID()}.wav`);
    const tmp16 = path.join(paths.data, `asr-${randomUUID()}-16k.wav`);
    fs.writeFileSync(tmp, wav);
    try {
      // Whisper-family models want 16 kHz mono
      await runFfmpeg(['-y', '-i', tmp, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp16]);
      const client = new AudioCppClient(ttsBaseUrl(), 'asr');
      const text = await client.transcribe(tmp16, language || undefined);
      return { text };
    } catch (err) {
      return reply.code(502).send({ error: `transcription failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(tmp16, { force: true });
    }
  });

  /**
   * Word-level forced alignment of the reference transcript against the
   * reference audio (Meta MMS, Polish via pre-romanized ASCII). Exposes each
   * word's exact position so the UI can play it in isolation and flag words
   * that don't line up — wrong transcript words are what make clones garble.
   */
  app.post('/api/voices/:id/align', async (req, reply) => {
    const { id } = req.params as { id: string };
    const voice = getDb().prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    if (!voice.reference_text.trim()) return reply.code(422).send({ error: 'voice has no transcript to align' });
    try {
      return await alignTranscript(voice.wav_path, voice.reference_text);
    } catch (err) {
      return reply.code(502).send({ error: `align failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  /**
   * Clone round-trip test: synthesize a short sentence with this voice, then
   * transcribe it back and diff against the sentence. The score shows whether
   * the clone itself drops/garbles words BEFORE committing to a full book.
   */
  app.post('/api/voices/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; language?: string; seed?: string };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    const text =
      (body.text ?? '').trim() ||
      'O żywocie ludzkim. Fraszki to wszytko, cokolwiek myślemy, fraszki to wszytko, cokolwiek czyniemy. Zacność, uroda, moc, pieniądze, sława, wszystko to minie jako polna trawa.';
    const settings = loadSettings();
    const tmp = path.join(paths.data, `clone-test-${randomUUID()}.wav`);
    try {
      const client = new AudioCppClient(ttsBaseUrl(), settings.model);
      const wav = await client.synthesize({
        input: text,
        language: body.language || undefined,
        voiceRefBase64: fs.readFileSync(voice.wav_path).toString('base64'),
        referenceText: voice.reference_text || undefined,
        seed: body.seed || undefined,
      });
      fs.writeFileSync(tmp, wav);
      const info = readWavInfo(wav);
      let qa: WordQa | null = null;
      try {
        qa = await qaTake(tmp, text, body.language || undefined);
      } catch {
        qa = null; // ASR unavailable — still return the audio
      }
      return { duration_ms: info.durationMs, qa, audio_base64: wav.toString('base64') };
    } catch (err) {
      return reply.code(502).send({ error: `clone test failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  // ---------- expert mode: reference cleanup & parameter bench ----------

  app.get('/api/voices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getDb().prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!row) return reply.code(404).send({ error: 'voice not found' });
    let durationMs: number | null = null;
    try {
      durationMs = readWavInfo(fs.readFileSync(row.wav_path)).durationMs;
    } catch {
      durationMs = null;
    }
    return {
      id: row.id,
      name: row.name,
      reference_text: row.reference_text,
      created_at: row.created_at,
      duration_ms: durationMs,
      synth_options: row.synth_options ? (JSON.parse(row.synth_options) as ExpertOptions) : null,
    };
  });

  /** Cleanup preview: run the filter chain on the current reference (nothing saved). */
  app.post('/api/voices/:id/cleanup', async (req, reply) => {
    const { id } = req.params as { id: string };
    const voice = getDb().prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    const body = (req.body ?? {}) as CleanupOptions;
    const out = path.join(paths.data, `cleanup-${randomUUID()}.wav`);
    try {
      const { durationMs, sizeBytes } = await applyVoiceCleanup(voice.wav_path, out, body);
      return reply
        .type('audio/wav')
        .header('X-Cleanup-Duration-Ms', String(durationMs))
        .header('X-Cleanup-Size-Bytes', String(sizeBytes))
        .send(fs.readFileSync(out));
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      fs.rmSync(out, { force: true });
    }
  });

  /** Measure the reference (loudness, edge silence) and suggest cleanup options. */
  app.post('/api/voices/:id/analyze', async (req, reply) => {
    const { id } = req.params as { id: string };
    const voice = getDb().prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    try {
      const analysis = await analyzeWav(voice.wav_path);
      const suggestion = suggestCleanup(analysis);
      return { ...analysis, suggestions: suggestion.options, notes: suggestion.notes };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Replace the reference WAV (transcript untouched) — cleanup "save as reference". */
  app.put('/api/voices/:id/audio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    const parts = req.parts({ limits: { fileSize: MAX_VOICE_WAV_BYTES } });
    let wav: Buffer | null = null;
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'wav') wav = await part.toBuffer();
    }
    if (!wav) return reply.code(400).send({ error: 'wav file is required' });
    try {
      readWavInfo(wav); // throws if not a valid WAV
    } catch (err) {
      return reply.code(422).send({ error: `invalid WAV: ${err instanceof Error ? err.message : String(err)}` });
    }
    fs.writeFileSync(voice.wav_path, wav);
    bus.emit('event', { type: 'voices.update' });
    return { ok: true, duration_ms: readWavInfo(wav).durationMs };
  });

  /**
   * Expert bench run: synthesize one sentence with explicit synthesis options,
   * score it with the ASR word-check, optionally keep it as a saved take.
   */
  app.post('/api/voices/:id/expert-run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string; language?: string; seed?: string; options?: unknown; saveTake?: boolean };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
    const text = (body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    const { options, rejected } = sanitizeExpertOptions(body.options);
    if (rejected.length > 0) return reply.code(400).send({ error: `unknown option(s): ${rejected.join(', ')}` });

    const settings = loadSettings();
    const tmp = path.join(paths.data, `expert-${randomUUID()}.wav`);
    try {
      const client = new AudioCppClient(ttsBaseUrl(), settings.model);
      const wav = await client.synthesize({
        input: text.slice(0, 600),
        language: body.language || undefined,
        voiceRefBase64: fs.readFileSync(voice.wav_path).toString('base64'),
        referenceText: voice.reference_text || undefined,
        seed: body.seed || undefined,
        ...expertOptionsToRequest(options),
      });
      fs.writeFileSync(tmp, wav);
      const info = readWavInfo(wav);
      let qa: WordQa | null = null;
      try {
        qa = await qaTake(tmp, text, body.language || undefined);
      } catch {
        qa = null; // ASR unavailable — still return the audio
      }
      let takeId: string | undefined;
      if (body.saveTake) {
        takeId = randomUUID();
        const dest = path.join(paths.voicesTakes, `${takeId}.wav`);
        fs.renameSync(tmp, dest);
        db.prepare(
          `INSERT INTO voice_takes (id, voice_id, created_at, text, language, options_json, wav_path, duration_ms, qa_json)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          takeId, id, new Date().toISOString(), text, body.language || null,
          JSON.stringify(options), dest, info.durationMs, qa ? JSON.stringify(qa) : null,
        );
      }
      return { duration_ms: info.durationMs, qa, audio_base64: wav.toString('base64'), takeId, options };
    } catch (err) {
      return reply.code(502).send({ error: `expert run failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  app.get('/api/voices/:id/takes', async (req) => {
    const { id } = req.params as { id: string };
    const rows = getDb()
      .prepare('SELECT * FROM voice_takes WHERE voice_id=? ORDER BY created_at DESC')
      .all(id) as unknown as VoiceTakeRow[];
    return rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      text: r.text,
      language: r.language,
      options: JSON.parse(r.options_json) as ExpertOptions,
      duration_ms: r.duration_ms,
      qa: r.qa_json ? JSON.parse(r.qa_json) : null,
    }));
  });

  app.delete('/api/voices/:id/takes/:takeId', async (req, reply) => {
    const { id, takeId } = req.params as { id: string; takeId: string };
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM voice_takes WHERE id=? AND voice_id=?')
      .get(takeId, id) as unknown as VoiceTakeRow | undefined;
    if (!row) return reply.code(404).send({ error: 'take not found' });
    db.prepare('DELETE FROM voice_takes WHERE id=?').run(takeId);
    fs.rmSync(row.wav_path, { force: true });
    return { ok: true };
  });

  app.get('/api/voices/:id/takes/:takeId/audio', async (req, reply) => {
    const { id, takeId } = req.params as { id: string; takeId: string };
    const row = getDb()
      .prepare('SELECT wav_path FROM voice_takes WHERE id=? AND voice_id=?')
      .get(takeId, id) as unknown as { wav_path: string } | undefined;
    if (!row || !fs.existsSync(row.wav_path)) return reply.code(404).send({ error: 'take not found' });
    return reply.type('audio/wav').send(fs.createReadStream(row.wav_path));
  });

  // ---------- SSE events ----------
  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write('retry: 2000\n\n');
    const listener = (ev: unknown) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    bus.on('event', listener);
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 20000);
    req.raw.on('close', () => {
      bus.off('event', listener);
      clearInterval(keepAlive);
    });
  });
}

// ---------- helpers ----------

interface BookSummary extends BookRow {
  chapter_count: number;
  chunk_count: number;
  chunks_done: number;
  chunks_failed: number;
  duration_ms: number;
  voice_name: string | null;
}

interface ChapterSummary extends ChapterRow {
  chunk_count: number;
  chunks_done: number;
  chunks_failed: number;
  duration_ms: number;
}

function publicSettings(s: AppSettings) {
  const { port, ...rest } = s;
  return { ...rest, port };
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
}
function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
}

/** Re-split one chapter's (new) text into chunks; returns the chunk count. */
function rechunkChapterText(chapterId: string, bookId: string, text: string, maxChunkChars: number): number {
  const db = getDb();
  const chunks = chunkText(text, maxChunkChars);
  chunks.forEach((chunk, ki) => {
    db.prepare(
      'INSERT INTO chunks (id, book_id, chapter_id, idx, text, char_start, char_end, status) VALUES (?,?,?,?,?,?,?,?)',
    ).run(randomUUID(), bookId, chapterId, ki, chunk.text, chunk.charStart, chunk.charEnd, 'pending');
  });
  db.prepare('UPDATE chapters SET char_count=? WHERE id=?').run(text.length, chapterId);
  return chunks.length;
}

function insertChaptersAndChunks(bookId: string, chapters: Array<{ title: string; text: string }>, maxChunkChars: number): void {
  const db = getDb();
  chapters.forEach((chapter, ci) => {
    const chapterId = randomUUID();
    db.prepare('INSERT INTO chapters (id, book_id, idx, title, char_count) VALUES (?,?,?,?,?)').run(
      chapterId, bookId, ci, chapter.title, chapter.text.length,
    );
    const chunks = chunkText(chapter.text, maxChunkChars);
    chunks.forEach((chunk, ki) => {
      db.prepare(
        'INSERT INTO chunks (id, book_id, chapter_id, idx, text, char_start, char_end, status) VALUES (?,?,?,?,?,?,?,?)',
      ).run(randomUUID(), bookId, chapterId, ki, chunk.text, chunk.charStart, chunk.charEnd, 'pending');
    });
  });
}

function rechunkBook(bookId: string, maxChunkChars: number): void {
  const db = getDb();
  // re-chunk from the stored source file so offsets stay honest
  const book = db.prepare('SELECT * FROM books WHERE id=?').get(bookId) as unknown as BookRow;
  const bookDir = path.join(paths.books, bookId);
  const sourceName = fs
    .readdirSync(bookDir, { withFileTypes: true })
    .find((e) => e.isFile() && e.name.startsWith('source'));
  if (!sourceName) throw new Error('source file missing — re-ingest the book');
  const sourcePath = path.join(bookDir, sourceName.name);
  const raw = fs.readFileSync(sourcePath);
  let chapters: Array<{ title: string; text: string }>;
  if (sourcePath.endsWith('.epub')) {
    chapters = parseEpub(new Uint8Array(raw)).chapters;
  } else {
    chapters = splitTxtChapters(raw.toString('utf8'));
  }
  db.prepare('DELETE FROM chunks WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM chapters WHERE book_id=?').run(bookId);
  insertChaptersAndChunks(bookId, chapters, maxChunkChars);
}

interface WordQaSummary {
  /** parts checked */
  checked: number;
  /** parts with missing words */
  flagged: number;
  missingWords: number;
  extraWords: number;
  /** (missing + extra) / source words across all parts */
  wer: number | null;
  /** report file name, next to the export */
  reportFile: string | null;
}

type StoredQa = WordQa & { durationMs: number };

/**
 * Word-check a generated chunk, reusing the stored verdict when it still
 * matches the current audio (duration changes on regeneration → re-check).
 */
async function qaChunkWithCache(chunk: ChunkRow, language?: string): Promise<StoredQa> {
  const db = getDb();
  if (chunk.qa) {
    try {
      const stored = JSON.parse(chunk.qa) as StoredQa;
      if (stored.durationMs === chunk.duration_ms) return stored;
    } catch {
      // stale or corrupt verdict → re-check below
    }
  }
  const qa = await qaTake(chunk.audio_path!, chunk.text, language);
  const stored: StoredQa = { ...qa, durationMs: chunk.duration_ms ?? 0 };
  db.prepare('UPDATE chunks SET qa=? WHERE id=?').run(JSON.stringify(stored), chunk.id);
  return stored;
}

/**
 * Write a human-readable QA report next to an export and return the summary.
 * `rows` are the export's checked chunks in playback order.
 */
function writeQaReport(
  exportPath: string,
  title: string,
  rows: Array<{ idx: number; chapterTitle?: string; qa: StoredQa }>,
): WordQaSummary {
  let missingWords = 0;
  let extraWords = 0;
  let sourceWords = 0;
  let flagged = 0;
  const lines: string[] = [title, '='.repeat(title.length), ''];
  for (const r of rows) {
    sourceWords += r.qa.sourceWords;
    missingWords += r.qa.missingCount;
    extraWords += r.qa.extra.length;
    const clean = r.qa.missing.length === 0;
    if (!clean) flagged++;
    lines.push(
      `#${r.idx}${r.chapterTitle ? ` — ${r.chapterTitle}` : ''} — ${clean ? 'clean' : 'MISSING WORDS'} (${(r.qa.durationMs / 1000).toFixed(1)}s)`,
    );
    if (r.qa.missing.length > 0) lines.push(`   missing: ${r.qa.missing.map((m) => `"${m}"`).join(', ')}`);
    if (r.qa.variants.length > 0) lines.push(`   variants (ok): ${r.qa.variants.join(', ')}`);
    if (r.qa.extra.length > 0) lines.push(`   not in text: ${r.qa.extra.join(', ')}`);
    lines.push(`   heard: ${r.qa.transcript}`, '');
  }
  const wer = sourceWords > 0 ? Number(((missingWords + extraWords) / sourceWords).toFixed(3)) : null;
  lines.unshift(
    '',
    `checked: ${rows.length} parts · flagged: ${flagged} · missing words: ${missingWords} · WER: ${wer ?? '—'}`,
  );
  const reportFile = `${exportPath.replace(/\.(mp3|m4b)$/i, '')}.qa.txt`;
  fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');
  return { checked: rows.length, flagged, missingWords, extraWords, wer, reportFile: path.basename(reportFile) };
}

function neighborIds(chunkId: string): { prev: string | null; next: string | null } {
  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE id=?').get(chunkId) as unknown as ChunkRow | undefined;
  if (!chunk) return { prev: null, next: null };
  const prev = db
    .prepare('SELECT id FROM chunks WHERE chapter_id=? AND idx<? ORDER BY idx DESC LIMIT 1')
    .get(chunk.chapter_id, chunk.idx) as unknown as { id: string } | undefined;
  const next = db
    .prepare('SELECT id FROM chunks WHERE chapter_id=? AND idx>? ORDER BY idx ASC LIMIT 1')
    .get(chunk.chapter_id, chunk.idx) as unknown as { id: string } | undefined;
  return { prev: prev?.id ?? null, next: next?.id ?? null };
}

function getBookPayload(id: string): unknown {
  const db = getDb();
  const book = db.prepare('SELECT * FROM books WHERE id=?').get(id);
  const chapters = db.prepare('SELECT * FROM chapters WHERE book_id=? ORDER BY idx').all(id);
  return { ...(book as object), chapters };
}
