import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, type BookRow, type ChunkRow } from '../db.js';
import { paths, loadSettings } from '../config.js';
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
 * work and releases the job. Single-chunk regeneration bypasses the queue but
 * is rejected while the book has a running job.
 */
export class TtsQueue {
  private client: AudioCppClient;
  private pausedJobs = new Set<string>();
  private active = 0;
  private regenerateLocks = new Set<string>();
  private pumping = false;

  constructor() {
    this.client = this.makeClient();
    this.recoverOnStartup();
  }

  private makeClient(): AudioCppClient {
    const s = loadSettings();
    return new AudioCppClient(s.audiocppUrl, s.model);
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
      db.prepare(
        'INSERT INTO jobs (id, book_id, state, total_chunks, done_chunks, failed_chunks, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, bookId, 'running', pending.n, 0, 0, new Date().toISOString());
      job = { id };
    } else {
      db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id);
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
      db.prepare("UPDATE jobs SET state='paused' WHERE id=?").run(job.id);
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
      db.prepare("UPDATE jobs SET state='canceled' WHERE id=?").run(job.id);
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
   * Regenerate a single chunk immediately (bypasses the queue). Rejected while
   * a generation job is active for the same book.
   */
  async regenerateChunk(chunkId: string, seed?: string): Promise<{ ok: true } | { error: string }> {
    const db = getDb();
    const chunk = db.prepare('SELECT * FROM chunks WHERE id=?').get(chunkId) as unknown as ChunkRow | undefined;
    if (!chunk) return { error: 'chunk not found' };
    if (this.regenerateLocks.has(chunk.book_id)) return { error: 'a generation job is active for this book' };
    this.regenerateLocks.add(chunk.book_id);
    try {
      await this.synthesizeChunk(chunk, seed);
      return { ok: true };
    } finally {
      this.regenerateLocks.delete(chunk.book_id);
      this.pump();
    }
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const maxConcurrency = Math.max(1, loadSettings().concurrency);
      while (this.active < maxConcurrency) {
        const claimed = this.claimNextChunk();
        if (!claimed) break;
        this.active++;
        void this.runChunk(claimed.chunk, claimed.jobId)
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

  private async runChunk(chunk: ChunkRow, jobId: string): Promise<void> {
    try {
      await this.synthesizeChunk(chunk);
      this.noteChunkDone(jobId, chunk);
    } catch (err) {
      this.noteChunkFailed(jobId, chunk, err);
    } finally {
      this.emitJobUpdate(chunk.book_id);
    }
  }

  /** Shared synthesis path for queue chunks and single regenerations. */
  private async synthesizeChunk(chunk: ChunkRow, seedOverride?: string): Promise<void> {
    const db = getDb();
    const book = db.prepare('SELECT * FROM books WHERE id=?').get(chunk.book_id) as unknown as BookRow;
    const settings = loadSettings();
    this.client = new AudioCppClient(settings.audiocppUrl, settings.model);

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
    if (updated.changes === 0) return;
    this.emit({
      type: 'chunk.update',
      bookId: chunk.book_id,
      chapterId: chunk.chapter_id,
      chunkId: chunk.id,
      status: 'done',
      durationMs: info.durationMs,
    });
  }

  private noteChunkDone(jobId: string, chunk: ChunkRow): void {
    const db = getDb();
    db.prepare('UPDATE jobs SET done_chunks=done_chunks+1 WHERE id=?').run(jobId);
    this.finishJobIfComplete(chunk.book_id, jobId);
  }

  private noteChunkFailed(jobId: string, chunk: ChunkRow, err: unknown): void {
    const db = getDb();
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE chunks SET status='failed', error=?, attempts=attempts+1 WHERE id=?").run(
      message.slice(0, 500),
      chunk.id,
    );
    db.prepare('UPDATE jobs SET failed_chunks=failed_chunks+1 WHERE id=?').run(jobId);
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
    db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(jobId);
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
