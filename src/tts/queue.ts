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
    // chunks stuck 'generating' from a previous crash go back to pending
    db.prepare("UPDATE chunks SET status='pending' WHERE status='generating'").run();
    db.prepare("UPDATE jobs SET state='paused' WHERE state='running'").run();
    db.prepare("UPDATE books SET status='paused' WHERE status='generating' OR status='queued'").run();
  }

  private emit(ev: StudioEvent): void {
    bus.emit('event', ev);
  }

  /** Queue all pending chunks of a book. Reuses an open job when present. */
  startBook(bookId: string): { jobId: string } | { error: string } {
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(bookId) as unknown as BookRow | undefined;
    if (!book) return { error: 'book not found' };
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id=? AND status IN ('pending','failed')")
      .get(bookId) as unknown as { n: number };
    if (pending.n === 0) return { error: 'no pending chunks' };

    let job = db
      .prepare("SELECT * FROM jobs WHERE book_id=? AND state IN ('running','paused') ORDER BY created_at DESC LIMIT 1")
      .get(bookId) as unknown as { id: string } | undefined;
    if (!job) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO jobs (id, book_id, state, total_chunks, done_chunks, failed_chunks, created_at, started_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(id, bookId, 'running', pending.n, 0, 0, now, now);
      job = { id };
    } else {
      // close any stale open segment (e.g. after a crash), then open a fresh one
      db.prepare(
        `UPDATE jobs SET wall_ms = wall_ms + CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
         WHERE id=? AND started_at IS NOT NULL`,
      ).run(job.id);
      db.prepare("UPDATE jobs SET state='running', started_at=?, finished_at=NULL WHERE id=?").run(
        new Date().toISOString(),
        job.id,
      );
    }
    this.pausedJobs.delete(job.id);
    db.prepare("UPDATE books SET status='generating', updated_at=? WHERE id=?").run(new Date().toISOString(), bookId);
    // failed chunks from a previous run become retryable when the job restarts
    db.prepare("UPDATE chunks SET status='pending', error=NULL WHERE book_id=? AND status='failed'").run(bookId);
    this.emit({ type: 'book.update', bookId, status: 'generating' });
    this.pump();
    return { jobId: job.id };
  }

  pauseBook(bookId: string): void {
    const db = getDb();
    const job = db
      .prepare("SELECT id FROM jobs WHERE book_id=? AND state='running'")
      .get(bookId) as unknown as { id: string } | undefined;
    if (job) {
      this.pausedJobs.add(job.id);
      db.prepare(
        `UPDATE jobs SET state='paused',
           wall_ms = wall_ms + CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
           started_at = NULL
         WHERE id=?`,
      ).run(job.id);
    }
    db.prepare("UPDATE books SET status='paused', updated_at=? WHERE id=?").run(new Date().toISOString(), bookId);
    this.emit({ type: 'book.update', bookId, status: 'paused' });
    this.emitJobUpdate(bookId);
  }

  cancelBook(bookId: string): void {
    const db = getDb();
    const job = db
      .prepare("SELECT id FROM jobs WHERE book_id=? AND state IN ('running','paused')")
      .get(bookId) as unknown as { id: string } | undefined;
    if (job) {
      this.pausedJobs.delete(job.id);
      db.prepare(
        `UPDATE jobs SET state='canceled',
           wall_ms = wall_ms + CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
           started_at = NULL,
           finished_at = ?
         WHERE id=?`,
      ).run(new Date().toISOString(), job.id);
    }
    db.prepare("UPDATE chunks SET status='pending', error=NULL WHERE book_id=? AND status='generating'").run(bookId);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id=? AND status='pending'")
      .get(bookId) as unknown as { n: number };
    const status = remaining.n > 0 ? 'paused' : 'done';
    db.prepare("UPDATE books SET status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), bookId);
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
    return { chunk, seed };
  }

  private claimNextChunk(): { chunk: ChunkRow; jobId: string } | null {
    const db = getDb();
    const jobs = db
      .prepare("SELECT id, book_id FROM jobs WHERE state='running' ORDER BY created_at ASC")
      .all() as unknown as Array<{ id: string; book_id: string }>;
    for (const job of jobs) {
      if (this.pausedJobs.has(job.id)) continue;
      const chunk = db
        .prepare(
          `SELECT * FROM chunks
           WHERE book_id=? AND status='pending'
           ORDER BY (SELECT idx FROM chapters WHERE id=chunks.chapter_id) ASC, idx ASC
           LIMIT 1`,
        )
        .get(job.book_id) as unknown as ChunkRow | undefined;
      if (!chunk) {
        // book exhausted → close its job and move on to the next one
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
      this.noteChunkFailed(jobId, chunk, err);
    } finally {
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
      try {
        const candidate = await this.client.synthesize({
          input: chunk.text,
          voiceRefBase64,
          referenceText,
          numInferenceSteps: book.num_inference_steps,
          guidanceScale: book.guidance_scale,
          speed: book.speed === 1 ? undefined : book.speed,
          seed: seedForAttempt(attempt),
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
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chunks WHERE book_id=? AND status IN ('pending','generating')) AS pending,
           (SELECT COUNT(*) FROM chunks WHERE book_id=? AND status='failed') AS failed`,
      )
      .get(bookId, bookId) as unknown as { pending: number; failed: number };
    if (counts.pending > 0) return;
    const job = db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId) as unknown as { state: string } | undefined;
    if (!job || job.state === 'canceled' || job.state === 'done') return;
    db.prepare(
      `UPDATE jobs SET state='done', finished_at=?,
         wall_ms = wall_ms + CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
         started_at = NULL
       WHERE id=?`,
    ).run(new Date().toISOString(), jobId);
    // a book with failed chunks is not "done" — pause it so the user can retry
    const status = counts.failed > 0 ? 'paused' : 'done';
    db.prepare("UPDATE books SET status=?, updated_at=? WHERE id=?").run(status, new Date().toISOString(), bookId);
    this.emit({ type: 'job.update', bookId, jobId, state: 'done', done: 0, total: 0, failed: 0 });
    this.emit({ type: 'book.update', bookId, status });
  }

  private emitJobUpdate(bookId: string): void {
    const db = getDb();
    const job = db
      .prepare(
        `SELECT id, state,
           (SELECT COUNT(*) FROM chunks WHERE book_id=jobs.book_id) AS total,
           (SELECT COUNT(*) FROM chunks WHERE book_id=jobs.book_id AND status='done') AS done,
           (SELECT COUNT(*) FROM chunks WHERE book_id=jobs.book_id AND status='failed') AS failed
         FROM jobs WHERE book_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(bookId) as
      | { id: string; state: string; total: number; done: number; failed: number }
      | undefined;
    if (!job) return;
    this.emit({
      type: 'job.update',
      bookId,
      jobId: job.id,
      state: job.state,
      done: job.done,
      total: job.total,
      failed: job.failed,
    });
  }
}

export const queue = new TtsQueue();
