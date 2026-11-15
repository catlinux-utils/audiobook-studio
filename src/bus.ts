import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus feeding the UI over SSE. Events are small status
 * snapshots — the UI always re-fetches authoritative state after receiving one.
 */
export type StudioEvent =
  | { type: 'chunk.update'; bookId: string; chapterId: string; chunkId: string; status: string; durationMs?: number; error?: string }
  | { type: 'job.update'; bookId: string; jobId: string; state: string; done: number; total: number; failed: number; chapterId?: string }
  | { type: 'book.update'; bookId: string; status: string }
  | { type: 'voices.update' };

class Bus extends EventEmitter {}
export const bus = new Bus();
bus.setMaxListeners(100);
