import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, type BookRow, type ChunkRow } from '../db.js';
import { paths, loadSettings } from '../config.js';
import { ttsBaseUrl } from './managed.js';
import { AudioCppClient, ServerBusyError, TtsRequestError } from './audiocpp.js';
import { readWavInfo } from '../audio/wavmeta.js';
import { bus, type StudioEvent } from '../bus.js';

/**
 * Generation queue.
 *
 * One job per book ("generate all pending chunks"). Chunks are claimed one at
 * a time (per configured concurrency), synthesized on the audio.cpp server,
 * written to data/books/<bookId>/chunks/, and their status/duration recorded.
 * Pause finishes the in-flight chunk and stops claiming; cancel keeps completed
 * work and releases the job. Single-chunk regeneration goes through the same
 * worker as a priority request: it preempts job chunk claiming, so it works
 * even while the book's generation job is running.
 */
export class TtsQueue {
  private regenQueue = new Map<string, string | undefined>(); // chunkId -> seed override
  private activeRegens = new Set<string>(); // chunkIds currently synthesizing via priority path
  private aborters = new Map<string, AbortController>(); // chunkId -> in-flight request controller
  private client: AudioCppClient;
  private pausedJobs = new Set<string>();
  private active = 0;
  private pumping = false;

  constructor() {
    this.client = this.makeClient();
    this.recoverOnStartup();
  }

  private makeClient(): AudioCppClient {
    const s = loadSettings();
    return new AudioCppClient(ttsBaseUrl(), s.model);
  }

  private recoverOnStartup(): void {
    const db = getDb();
    // chunks stuck 'generating' from a previous crash go back to pending;
    // open jobs (running or waiting in the chapter queue) stop — resuming is
    // an explicit user action, never something the server does on its own
    db.prepare("UPDATE chunks SET status='pending' WHERE status='generating'").run();
    db.prepare("UPDATE jobs SET state='paused' WHERE state IN ('running','queued')").run();
    db.prepare("UPDATE books SET status='paused' WHERE status='generating' OR status='queued'").run();
  }

  private emit(ev: StudioEvent): void {
    bus.emit('event', ev);
  }

  /**
   * Queue work for a book: either the whole book (chapterId omitted) or one
   * chapter. Chapter requests join a FIFO chapter queue — they run one after
   * another as the worker frees up; several chapters can wait at once.
   */
  startBook(bookId: string, chapterId?: string): { jobId: string } | { error: string } {
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(bookId) as unknown as BookRow | undefined;
    if (!book) return { error: 'book not found' };

    if (!chapterId) {
      return this.startBookWide(bookId);
    }

    const chapter = db
      .prepare('SELECT id, title FROM chapters WHERE id=? AND book_id=?')
      .get(chapterId, bookId) as unknown as { id: string; title: string } | undefined;
    if (!chapter) return { error: 'chapter not found' };

    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id=? AND chapter_id=? AND status IN ('pending','failed')")
      .get(bookId, chapterId) as unknown as { n: number };
    if (pending.n === 0) return { error: 'this chapter has no pending chunks' };

    // an open book-wide job (no chapter, no explicit chunk list) covers everything
    const bookWide = db
      .prepare(
        `SELECT id, state FROM jobs
         WHERE book_id=? AND chapter_id IS NULL AND state IN ('running','paused','queued')
           AND NOT EXISTS (SELECT 1 FROM job_chunks jc WHERE jc.job_id=jobs.id) LIMIT 1`,
      )
      .get(bookId) as unknown as { id: string; state: string } | undefined;
    if (bookWide && bookWide.state === 'running') {
      return { error: 'book-wide generation is already running — it covers this chapter' };
    }
    if (bookWide) {
      this.closeJob(bookWide.id, 'canceled');
      this.pausedJobs.delete(bookWide.id);
    }

    const sameChapter = db
      .prepare("SELECT id, state FROM jobs WHERE book_id=? AND chapter_id=? AND state IN ('running','paused','queued') LIMIT 1")
      .get(bookId, chapterId) as unknown as { id: string; state: string } | undefined;
    if (sameChapter) {
      if (sameChapter.state === 'paused') {
        // explicit retry of a paused chapter — put it back to work
        this.pausedJobs.delete(sameChapter.id);
        db.prepare("UPDATE jobs SET state='running', started_at=?, finished_at=NULL WHERE id=?").run(
          new Date().toISOString(),
          sameChapter.id,
        );
        this.refreshBookStatus(bookId);
        this.emit({ type: 'book.update', bookId, status: 'generating' });
        this.pump();
        return { jobId: sameChapter.id };
      }
      return { error: 'this chapter is already queued for generation' };
    }

    const running = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE book_id=? AND state='running'")
      .get(bookId) as unknown as { n: number };
    // nothing running for this book → start immediately; otherwise wait in line
    const state = running.n > 0 ? 'queued' : 'running';
    const jobId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO jobs (id, book_id, chapter_id, state, total_chunks, done_chunks, failed_chunks, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(jobId, bookId, chapterId, state, pending.n, 0, 0, now, state === 'running' ? now : null);

    // failed chunks of this chapter become retryable when its job starts
    db.prepare("UPDATE chunks SET status='pending', error=NULL WHERE book_id=? AND chapter_id=? AND status='failed'").run(
      bookId,
      chapterId,
    );
    this.refreshBookStatus(bookId);
    this.emit({ type: 'book.update', bookId, status: state === 'running' ? 'generating' : 'queued' });
    this.pump();
    return { jobId };
  }

  /** Book-wide generation absorbs any open chapter jobs (queued or running). */
  private startBookWide(bookId: string): { jobId: string } | { error: string } {
    const db = getDb();
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id=? AND status IN ('pending','failed')")
      .get(bookId) as unknown as { n: number };
    if (pending.n === 0) return { error: 'no pending chunks' };

    const openBookWide = db
      .prepare(
        `SELECT id FROM jobs
         WHERE book_id=? AND chapter_id IS NULL AND state IN ('running','paused','queued')
           AND NOT EXISTS (SELECT 1 FROM job_chunks jc WHERE jc.job_id=jobs.id) LIMIT 1`,
      )
      .get(bookId) as unknown as { id: string } | undefined;
    if (!openBookWide) {
      // supersede open chapter jobs and chunk selections — the book-wide scope covers their work
      const openScopedJobs = db
        .prepare(
          `SELECT id FROM jobs WHERE book_id=? AND state IN ('running','paused','queued')
           AND (chapter_id IS NOT NULL OR EXISTS (SELECT 1 FROM job_chunks jc WHERE jc.job_id=jobs.id))`,
        )
        .all(bookId) as unknown as Array<{ id: string }>;
      for (const j of openScopedJobs) {
        this.closeJob(j.id, 'canceled');
        this.pausedJobs.delete(j.id);
      }
    }

    let jobId: string;
    if (openBookWide) {
      jobId = openBookWide.id;
      this.pausedJobs.delete(jobId);
      db.prepare(
        `UPDATE jobs SET state='running', started_at=COALESCE(started_at, ?), finished_at=NULL WHERE id=?`,
      ).run(new Date().toISOString(), jobId);
    } else {
      jobId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO jobs (id, book_id, chapter_id, state, total_chunks, done_chunks, failed_chunks, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(jobId, bookId, null, 'running', pending.n, 0, 0, now, now);
    }
    // failed chunks from a previous run become retryable when the job restarts
    db.prepare("UPDATE chunks SET status='pending', error=NULL WHERE book_id=? AND status='failed'").run(bookId);
    db.prepare("UPDATE books SET status='generating', updated_at=? WHERE id=?").run(new Date().toISOString(), bookId);
    this.emit({ type: 'book.update', bookId, status: 'generating' });
    this.pump();
    return { jobId };
  }

  /** Close a job row with wall-time accounting. */
  private closeJob(jobId: string, state: 'canceled' | 'done' | 'paused'): void {
    getDb()
      .prepare(
        `UPDATE jobs SET state=?, finished_at=?,
           wall_ms = wall_ms + CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
           started_at = NULL
         WHERE id=?`,
      )
      .run(state, new Date().toISOString(), jobId);
  }

  /** Book status follows its jobs: running → generating, queued → queued, else by chunk leftovers. */
  private refreshBookStatus(bookId: string): 'generating' | 'queued' | 'paused' | 'done' {
    const db = getDb();
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM jobs WHERE book_id=? AND state='running') AS running,
           (SELECT COUNT(*) FROM jobs WHERE book_id=? AND state='queued') AS queued,
           (SELECT COUNT(*) FROM chunks WHERE book_id=? AND status IN ('pending','generating')) AS pending,
           (SELECT COUNT(*) FROM chunks WHERE book_id=? AND status='failed') AS failed`,
      )
      .get(bookId, bookId, bookId, bookId) as unknown as {
      running: number;
      queued: number;
      pending: number;
      failed: number;
    };
    const status =
      counts.running > 0
        ? 'generating'
        : counts.queued > 0
          ? 'queued'
          : counts.pending > 0 || counts.failed > 0
            ? 'paused'
            : 'done';
    db.prepare("UPDATE books SET status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), bookId);
    return status;
  }

  pauseBook(bookId: string): void {
    const db = getDb();
    // stop the running job AND everything waiting in the chapter queue
    const openJobs = db
      .prepare("SELECT id, state, started_at FROM jobs WHERE book_id=? AND state IN ('running','queued')")
      .all(bookId) as unknown as Array<{ id: string; state: string; started_at: string | null }>;
    for (const j of openJobs) {
      if (j.state === 'running') this.pausedJobs.add(j.id);
      db.prepare(
        `UPDATE jobs SET state='paused',
           wall_ms = wall_ms + CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
           started_at = NULL
         WHERE id=?`,
      ).run(j.id);
    }
    db.prepare("UPDATE books SET status='paused', updated_at=? WHERE id=?").run(new Date().toISOString(), bookId);
    this.emit({ type: 'book.update', bookId, status: 'paused' });
    this.emitJobUpdate(bookId);
  }

  cancelBook(bookId: string): void {
    const db = getDb();
    const openJobs = db
      .prepare("SELECT id, state FROM jobs WHERE book_id=? AND state IN ('running','paused','queued')")
      .all(bookId) as unknown as Array<{ id: string; state: string }>;
    for (const j of openJobs) {
      this.pausedJobs.delete(j.id);
      this.closeJob(j.id, 'canceled');
    }
    // abort in-flight synthesis requests for this book's generating chunks,
    // then reset them so the aborted runner sees 'pending' and stays quiet
    const generating = db
      .prepare("SELECT id FROM chunks WHERE book_id=? AND status='generating'")
      .all(bookId) as unknown as Array<{ id: string }>;
    for (const g of generating) this.aborters.get(g.id)?.abort();
    db.prepare("UPDATE chunks SET status='pending', error=NULL WHERE book_id=? AND status='generating'").run(bookId);
    const status = this.refreshBookStatus(bookId);
    this.emit({ type: 'book.update', bookId, status });
    this.emitJobUpdate(bookId);
  }

  /**
   * Queue a single-chunk regeneration as a PRIORITY request: the worker picks
   * it up before job chunks, so it works even while the book's generation job
   * is running (and shares the concurrency limit with it).
   */
  async regenerateChunk(chunkId: string, seed?: string): Promise<{ ok: true } | { error: string }> {
    const db = getDb();
    const chunk = db.prepare('SELECT * FROM chunks WHERE id=?').get(chunkId) as unknown as ChunkRow | undefined;
    if (!chunk) return { error: 'chunk not found' };
    if (this.regenQueue.has(chunkId)) return { error: 'this chunk is already queued for regeneration' };
    if (chunk.status === 'generating') return { error: 'chunk is currently generating — wait for it to finish' };
    this.regenQueue.set(chunkId, seed);
    this.pump();
    return { ok: true };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const maxConcurrency = Math.max(1, loadSettings().concurrency);
      while (this.active < maxConcurrency) {
        // priority: queued chunk regenerations preempt job chunk claiming
        const regen = this.claimNextRegen();
        const claimed = regen ?? this.claimNextChunk();
        if (!claimed) break;
        this.active++;
        const jobId = 'jobId' in claimed ? (claimed.jobId as string) : null;
        const seed = 'seed' in claimed ? (claimed.seed as string | undefined) : undefined;
        void this.runChunk(claimed.chunk, jobId, seed)
          .catch((err) => {
            // runChunk handles its own errors; this guards unexpected throws
            console.error('chunk runner crashed:', err);
          })
          .finally(() => {
            this.active--;
            this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Pop the oldest queued regeneration, if its chunk can be claimed now. */
  private claimNextRegen(): { chunk: ChunkRow; seed: string | undefined } | null {
    const chunkId = this.regenQueue.keys().next().value as string | undefined;
    if (chunkId === undefined) return null;
    const chunk = getDb().prepare('SELECT * FROM chunks WHERE id=?').get(chunkId) as unknown as ChunkRow | undefined;
    if (!chunk) {
      this.regenQueue.delete(chunkId);
      return null;
    }
    if (chunk.status === 'generating') return null; // busy; retry on next pump tick
    const seed = this.regenQueue.get(chunkId);
    this.regenQueue.delete(chunkId);
    getDb().prepare("UPDATE chunks SET status='generating', error=NULL WHERE id=?").run(chunk.id);
    this.activeRegens.add(chunk.id);
    return { chunk, seed };
  }

  /** Live regeneration activity for the Queue UI (queued + in-flight). */
  getRegenActivity(): Array<{ chunkId: string; bookId: string; state: 'queued' | 'generating' }> {
    const out: Array<{ chunkId: string; bookId: string; state: 'queued' | 'generating' }> = [];
    for (const chunkId of this.regenQueue.keys()) {
      const chunk = getDb().prepare('SELECT book_id FROM chunks WHERE id=?').get(chunkId) as unknown as
        | { book_id: string }
        | undefined;
      if (chunk) out.push({ chunkId, bookId: chunk.book_id, state: 'queued' });
    }
    for (const chunkId of this.activeRegens) {
      const chunk = getDb().prepare('SELECT book_id FROM chunks WHERE id=?').get(chunkId) as unknown as
        | { book_id: string }
        | undefined;
      if (chunk) out.push({ chunkId, bookId: chunk.book_id, state: 'generating' });
    }
    return out;
  }

  /**
   * Queue an explicit set of chunks (user-selected parts) as one job. Selected
   * chunks that are done or failed are reset to pending — checking them means
   * "(re)generate this part".
   */
  startChunks(bookId: string, chunkIds: string[]): { jobId: string } | { error: string } {
    const db = getDb();
    if (chunkIds.length === 0) return { error: 'no chunks selected' };
    const unique = [...new Set(chunkIds)];
    const placeholders = unique.map(() => '?').join(',');
    const chunks = db
      .prepare(`SELECT id, status FROM chunks WHERE book_id=? AND id IN (${placeholders})`)
      .all(bookId, ...unique) as unknown as Array<{ id: string; status: string }>;
    if (chunks.length === 0) return { error: 'no such chunks in this book' };
    if (chunks.length < unique.length) return { error: 'some selected chunks do not belong to this book' };

    const bookWide = db
      .prepare(
        `SELECT id, state FROM jobs
         WHERE book_id=? AND chapter_id IS NULL AND state IN ('running','paused','queued')
           AND NOT EXISTS (SELECT 1 FROM job_chunks jc WHERE jc.job_id=jobs.id) LIMIT 1`,
      )
      .get(bookId) as unknown as { id: string; state: string } | undefined;
    if (bookWide && bookWide.state === 'running') {
      return { error: 'book-wide generation is already running — it covers these parts' };
    }
    if (bookWide) {
      this.closeJob(bookWide.id, 'canceled');
      this.pausedJobs.delete(bookWide.id);
    }

    const running = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE book_id=? AND state='running'")
      .get(bookId) as unknown as { n: number };
    const state = running.n > 0 ? 'queued' : 'running';
    const jobId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO jobs (id, book_id, chapter_id, state, total_chunks, done_chunks, failed_chunks, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(jobId, bookId, null, state, chunks.length, 0, 0, now, state === 'running' ? now : null);
    const insertChunk = db.prepare('INSERT OR IGNORE INTO job_chunks (job_id, chunk_id) VALUES (?,?)');
    for (const c of chunks) insertChunk.run(jobId, c.id);
    db.prepare(
      `UPDATE chunks SET status='pending', error=NULL
       WHERE book_id=? AND status IN ('done','failed') AND id IN (${placeholders})`,
    ).run(bookId, ...unique);

    this.refreshBookStatus(bookId);
    this.emit({ type: 'book.update', bookId, status: state === 'running' ? 'generating' : 'queued' });
    this.pump();
    return { jobId };
  }

  private claimNextChunk(): { chunk: ChunkRow; jobId: string } | null {
    const db = getDb();
    // FIFO promotion: the oldest queued chapter whose book has nothing
    // running takes the worker next (called on every pump, so promotion
    // cascades naturally as jobs finish)
    const promotable = db
      .prepare(
        `SELECT j.id FROM jobs j
         WHERE j.state='queued'
           AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.book_id=j.book_id AND r.state='running')
         ORDER BY j.created_at ASC LIMIT 1`,
      )
      .get() as unknown as { id: string } | undefined;
    if (promotable) {
      const job = db.prepare('SELECT book_id FROM jobs WHERE id=?').get(promotable.id) as unknown as
        | { book_id: string }
        | undefined;
      db.prepare("UPDATE jobs SET state='running', started_at=? WHERE id=?").run(new Date().toISOString(), promotable.id);
      if (job) {
        db.prepare("UPDATE books SET status='generating', updated_at=? WHERE id=?").run(
          new Date().toISOString(),
          job.book_id,
        );
        this.emit({ type: 'book.update', bookId: job.book_id, status: 'generating' });
        this.emitJobUpdate(job.book_id);
      }
    }

    const jobs = db
      .prepare("SELECT id, book_id, chapter_id FROM jobs WHERE state='running' ORDER BY created_at ASC")
      .all() as unknown as Array<{ id: string; book_id: string; chapter_id: string | null }>;
    for (const job of jobs) {
      if (this.pausedJobs.has(job.id)) continue;
      // scope: explicit chunk list > single chapter > whole book
      const hasList = db
        .prepare('SELECT 1 FROM job_chunks WHERE job_id=? LIMIT 1')
        .get(job.id);
      const chunk = hasList
        ? (db
            .prepare(
              `SELECT k.* FROM chunks k
               JOIN job_chunks jc ON jc.chunk_id=k.id AND jc.job_id=?
               WHERE k.book_id=? AND k.status='pending'
               ORDER BY (SELECT idx FROM chapters WHERE id=k.chapter_id) ASC, k.idx ASC
               LIMIT 1`,
            )
            .get(job.id, job.book_id) as unknown as ChunkRow | undefined)
        : job.chapter_id
          ? (db
              .prepare(
                `SELECT * FROM chunks
                 WHERE book_id=? AND chapter_id=? AND status='pending'
                 ORDER BY (SELECT idx FROM chapters WHERE id=chunks.chapter_id) ASC, idx ASC
                 LIMIT 1`,
              )
              .get(job.book_id, job.chapter_id) as unknown as ChunkRow | undefined)
          : (db
              .prepare(
                `SELECT * FROM chunks
                 WHERE book_id=? AND status='pending'
                 ORDER BY (SELECT idx FROM chapters WHERE id=chunks.chapter_id) ASC, idx ASC
                 LIMIT 1`,
              )
              .get(job.book_id) as unknown as ChunkRow | undefined);
      if (!chunk) {
        // scope exhausted → close its job and move on to the next one
        this.finishJobIfComplete(job.book_id, job.id);
        continue;
      }
      db.prepare("UPDATE chunks SET status='generating', error=NULL WHERE id=?").run(chunk.id);
      return { chunk, jobId: job.id };
    }
    return null;
  }

  private async runChunk(chunk: ChunkRow, jobId: string | null, seedOverride?: string): Promise<void> {
    try {
      const { durationMs } = await this.synthesizeChunk(chunk, seedOverride);
      this.noteChunkDone(jobId, chunk, durationMs);
    } catch (err) {
      // if the chunk was reset by cancelBook while we were in flight, the
      // request was deliberately aborted — don't mark it failed
      const current = getDb().prepare('SELECT status FROM chunks WHERE id=?').get(chunk.id) as unknown as
        | { status: string }
        | undefined;
      if (current?.status === 'pending') return;
      this.noteChunkFailed(jobId, chunk, err);
    } finally {
      this.activeRegens.delete(chunk.id);
      if (jobId) this.emitJobUpdate(chunk.book_id);
    }
  }

  /** Shared synthesis path for queue chunks and single regenerations. */
  private async synthesizeChunk(chunk: ChunkRow, seedOverride?: string): Promise<{ durationMs: number }> {
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(chunk.book_id) as unknown as BookRow;
    const settings = loadSettings();
    this.client = new AudioCppClient(ttsBaseUrl(), settings.model);

    let voiceRefBase64: string | undefined;
    let referenceText: string | undefined;
    if (book.voice_id) {
      const voice = db.prepare('SELECT * FROM voices WHERE id=?').get(book.voice_id) as unknown as
        | { wav_path: string; reference_text: string }
        | undefined;
      if (voice) {
        voiceRefBase64 = fs.readFileSync(voice.wav_path).toString('base64');
        referenceText = voice.reference_text || undefined;
      }
    }

    // Diffusion samplers occasionally collapse on a specific (seed, steps,
    // text) combination and return an empty/valid WAV. Retry with a bumped
    // seed — deterministic per chunk so takes stay reproducible.
    const baseSeed = Number(seedOverride ?? book.seed ?? '0');
    const seedForAttempt = (attempt: number): string | undefined => {
      if (attempt === 0) return seedOverride ?? book.seed ?? undefined;
      const base = Number.isFinite(baseSeed) && baseSeed > 0 ? baseSeed : 7919 * (chunk.idx + 1);
      return String((base + attempt * 104729) % 4294967295);
    };

    const maxAttempts = 4;
    let wav: Buffer | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const aborter = new AbortController();
      this.aborters.set(chunk.id, aborter);
      try {
        const candidate = await this.client.synthesize({
          input: chunk.text,
          language: book.language || undefined,
          voiceRefBase64,
          referenceText,
          numInferenceSteps: book.num_inference_steps,
          guidanceScale: book.guidance_scale,
          speed: book.speed === 1 ? undefined : book.speed,
          seed: seedForAttempt(attempt),
          signal: aborter.signal,
        });
        const info = readWavInfo(candidate);
        if (info.durationMs < 250) {
          lastError = new Error(`degenerate synthesis output (empty audio), seed=${seedForAttempt(attempt) ?? 'random'}`);
          continue;
        }
        wav = candidate;
        break;
      } catch (err) {
        lastError = err;
        // network/parse errors from the client already retried internally;
        // parse failures on valid-size responses are treated as degenerate too
        if (err instanceof Error && err.message.includes('WAV data chunk missing')) continue;
        throw err;
      } finally {
        this.aborters.delete(chunk.id);
      }
    }
    if (!wav) {
      throw lastError instanceof Error ? lastError : new Error('synthesis failed');
    }

    const dir = path.join(paths.books, chunk.book_id, 'chunks');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${chunk.chapter_id}_${String(chunk.idx).padStart(4, '0')}.wav`);
    fs.writeFileSync(file, wav);
    const info = readWavInfo(wav);

    const updated = db
      .prepare(
        "UPDATE chunks SET status='done', audio_path=?, duration_ms=?, error=NULL, attempts=attempts+1 WHERE id=?",
      )
      .run(file, info.durationMs, chunk.id);
    if (updated.changes === 0) return { durationMs: info.durationMs };
    this.emit({
      type: 'chunk.update',
      bookId: chunk.book_id,
      chapterId: chunk.chapter_id,
      chunkId: chunk.id,
      status: 'done',
      durationMs: info.durationMs,
    });
    return { durationMs: info.durationMs };
  }

  private noteChunkDone(jobId: string | null, chunk: ChunkRow, durationMs: number): void {
    if (jobId === null) return; // priority regeneration — no job to account for
    const db = getDb();
    db.prepare('UPDATE jobs SET done_chunks=done_chunks+1, audio_ms=audio_ms+? WHERE id=?').run(durationMs, jobId);
    this.finishJobIfComplete(chunk.book_id, jobId);
  }

  private noteChunkFailed(jobId: string | null, chunk: ChunkRow, err: unknown): void {
    const db = getDb();
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE chunks SET status='failed', error=?, attempts=attempts+1 WHERE id=?").run(
      message.slice(0, 500),
      chunk.id,
    );
    if (jobId !== null) db.prepare('UPDATE jobs SET failed_chunks=failed_chunks+1 WHERE id=?').run(jobId);
    this.emit({
      type: 'chunk.update',
      bookId: chunk.book_id,
      chapterId: chunk.chapter_id,
      chunkId: chunk.id,
      status: 'failed',
      error: message.slice(0, 300),
    });
    // a busy server is transient — keep the job alive; hard errors too get
    // retried by the user from the UI
  }

  private finishJobIfComplete(bookId: string, jobId: string): void {
    const db = getDb();
    const job = db
      .prepare('SELECT state, chapter_id FROM jobs WHERE id=?')
      .get(jobId) as unknown as { state: string; chapter_id: string | null } | undefined;
    if (!job || job.state === 'canceled' || job.state === 'done') return;
    // "complete" means the job's own scope is exhausted — remaining chapters
    // keep the book paused/queued via refreshBookStatus
    const hasList = db.prepare('SELECT 1 FROM job_chunks WHERE job_id=? LIMIT 1').get(jobId);
    const scopeFilter = hasList
      ? 'AND id IN (SELECT chunk_id FROM job_chunks WHERE job_id=?)'
      : job.chapter_id
        ? 'AND chapter_id=?'
        : '';
    // the list filter expands to TWO placeholders (book_id + job_id)
    const scopeArgs = hasList ? [bookId, jobId] : job.chapter_id ? [bookId, job.chapter_id] : [bookId];
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chunks WHERE book_id=? ${scopeFilter} AND status IN ('pending','generating')) AS pending,
           (SELECT COUNT(*) FROM chunks WHERE book_id=? ${scopeFilter} AND status='failed') AS failed`,
      )
      .get(...scopeArgs) as unknown as { pending: number; failed: number };
    if (counts.pending > 0) return;
    this.closeJob(jobId, 'done');
    const status = this.refreshBookStatus(bookId);
    this.emit({ type: 'job.update', bookId, jobId, state: 'done', done: 0, total: 0, failed: 0 });
    this.emit({ type: 'book.update', bookId, status });
  }

  private emitJobUpdate(bookId: string): void {
    const db = getDb();
    // scope the progress readout to the newest job: explicit chunk list >
    // chapter > whole book
    const scopeSql =
      '(jobs.chapter_id IS NULL OR k.chapter_id=jobs.chapter_id) AND (NOT EXISTS (SELECT 1 FROM job_chunks jx WHERE jx.job_id=jobs.id) OR k.id IN (SELECT chunk_id FROM job_chunks WHERE job_id=jobs.id))';
    const job = db
      .prepare(
        `SELECT id, state, chapter_id,
           (SELECT COUNT(*) FROM chunks k WHERE k.book_id=jobs.book_id AND ${scopeSql}) AS total,
           (SELECT COUNT(*) FROM chunks k WHERE k.book_id=jobs.book_id AND k.status='done' AND ${scopeSql}) AS done,
           (SELECT COUNT(*) FROM chunks k WHERE k.book_id=jobs.book_id AND k.status='failed' AND ${scopeSql}) AS failed
         FROM jobs WHERE book_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(bookId) as
      | { id: string; state: string; chapter_id: string | null; total: number; done: number; failed: number }
      | undefined;
    if (!job) return;
    this.emit({
      type: 'job.update',
      bookId,
      jobId: job.id,
      chapterId: job.chapter_id ?? undefined,
      state: job.state,
      done: job.done,
      total: job.total,
      failed: job.failed,
    });
  }
}

export const queue = new TtsQueue();
