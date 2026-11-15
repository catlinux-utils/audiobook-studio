import type { FastifyInstance } from 'fastify';
import '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, type BookRow, type ChapterRow, type ChunkRow, type VoiceRow } from '../db.js';
import { paths, loadSettings, saveSettings, type AppSettings } from '../config.js';
import { parseEpub } from '../ingest/epub.js';
import { splitTxtChapters } from '../ingest/txt.js';
import { chunkText } from '../ingest/chunker.js';
import { queue } from '../tts/queue.js';
import { AudioCppClient } from '../tts/audiocpp.js';
import { readWavInfo } from '../audio/wavmeta.js';
import { assembleChapter, exportM4b, exportChapterMp3 } from '../audio/assemble.js';
import { bus } from '../bus.js';

const MAX_VOICE_WAV_BYTES = 3.5 * 1024 * 1024; // inline voice_ref payloads are capped at 5 MiB base64

export function registerRoutes(app: FastifyInstance): void {
  // ---------- health ----------
  app.get('/api/health', async () => {
    const s = loadSettings();
    const client = new AudioCppClient(s.audiocppUrl, s.model);
    try {
      const info = await client.health();
      return { ok: true, audiocpp: info, settings: publicSettings(s) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), settings: publicSettings(s) };
    }
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => publicSettings(loadSettings()));
  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Partial<AppSettings>;
    const current = loadSettings();
    const next: AppSettings = {
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
    return { id: bookId };
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
    return { ...book, voice: voice ?? null, chapters };
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
    }
    return getBookPayload(id);
  });

  app.delete('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    queue.cancelBook(id);
    const db = getDb();
    db.prepare('DELETE FROM books WHERE id=?').run(id);
    fs.rmSync(path.join(paths.books, id), { recursive: true, force: true });
    return { ok: true };
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
  app.post('/api/books/:id/pause', async (req) => queue.pauseBook((req.params as { id: string }).id));
  app.post('/api/books/:id/cancel', async (req) => queue.cancelBook((req.params as { id: string }).id));

  app.post('/api/books/:id/rechunk', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(id) as unknown as BookRow | undefined;
    if (!book) return reply.code(404).send({ error: 'book not found' });
    rechunkBook(id, book.max_chunk_chars);
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
      const record = { id: randomUUID(), book_id: id, format: 'm4b', path: m4b.path, chapter_count: assembled.length, duration_ms: m4b.durationMs, created_at: new Date().toISOString() };
      db.prepare('INSERT INTO exports (id, book_id, format, path, chapter_count, duration_ms, created_at) VALUES (?,?,?,?,?,?,?)').run(
        record.id, record.book_id, record.format, record.path, record.chapter_count, record.duration_ms, record.created_at,
      );
      return { export: record };
    } catch (err) {
      return reply.code(500).send({ error: `export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get('/api/books/:id/exports', async (req) => {
    const { id } = req.params as { id: string };
    return getDb().prepare('SELECT id, format, path, chapter_count, duration_ms, created_at FROM exports WHERE book_id=? ORDER BY created_at DESC').all(id);
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

  // ---------- voices ----------
  app.get('/api/voices', async () => {
    return getDb().prepare('SELECT id, name, reference_text, created_at FROM voices ORDER BY name').all();
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

  app.delete('/api/voices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(id) as unknown as VoiceRow | undefined;
    if (!voice) return reply.code(404).send({ error: 'voice not found' });
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
    const client = new AudioCppClient(s.audiocppUrl, s.model);
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
  const sourcePath = path.join(paths.books, bookId, fs.readdirSync(path.join(paths.books, bookId)).find((f) => f.startsWith('source')) ?? '');
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
