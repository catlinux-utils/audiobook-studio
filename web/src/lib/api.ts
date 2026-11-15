/** Typed fetch helpers for the studio API. */

export interface Book {
  id: string;
  title: string;
  author: string;
  language: string;
  cover_path: string | null;
  status: 'draft' | 'queued' | 'generating' | 'paused' | 'done';
  voice_id: string | null;
  voice_name: string | null;
  max_chunk_chars: number;
  num_inference_steps: number;
  guidance_scale: number;
  speed: number;
  seed: string | null;
  chapter_count?: number;
  chunk_count?: number;
  chunks_done?: number;
  chunks_failed?: number;
  duration_ms?: number;
  created_at: string;
}

export interface Chapter {
  id: string;
  idx: number;
  title: string;
  char_count: number;
  chunk_count: number;
  chunks_done: number;
  chunks_failed: number;
  duration_ms: number;
}

export interface Chunk {
  id: string;
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
  status: 'pending' | 'generating' | 'done' | 'failed';
  duration_ms: number | null;
  error: string | null;
  attempts: number;
}

export interface Voice {
  id: string;
  name: string;
  reference_text: string;
  created_at: string;
}

export interface JobStats {
  state: string;
  done: number;
  total: number;
  failed: number;
  audioMs: number;
  wallMs: number;
  speedFactor: number | null;
  etaMs: number | null;
}

export interface RegenActivity {
  chunkId: string;
  bookId: string;
  state: 'queued' | 'generating';
  chunkIdx: number;
  chapterTitle: string;
  chapterIdx: number;
  bookTitle: string;
}

export interface Stats {
  lifetime: {
    books: number;
    chunks_done: number;
    chunks_failed: number;
    audio_ms: number;
    genWallMs: number;
    speedFactor: number | null;
  };
  jobs: Array<JobStats & { jobId: string; bookId: string; title: string }>;
  regens: RegenActivity[];
}

export interface Settings {
  ttsMode: 'managed' | 'external';
  managedPort: number;
  audiocppUrl: string;
  model: string;
  concurrency: number;
  ffmpegPath: string;
  defaultMaxChunkChars: number;
  port: number;
}

export interface Health {
  ok: boolean;
  mode?: 'managed' | 'external';
  audiocpp?: { status: string; backend?: string; models?: number; version?: string; git?: string };
  error?: string;
}

export interface QaSample {
  id: string;
  book_id: string;
  chapter_id: string;
  idx: number;
  text: string;
  duration_ms: number;
  chapter_title: string;
  chapter_idx: number;
  prevChunkId: string | null;
  nextChunkId: string | null;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      /* non-JSON error */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => req<Health>('GET', '/api/health'),
  getStats: () => req<Stats>('GET', '/api/stats'),
  getSettings: () => req<Settings>('GET', '/api/settings'),
  putSettings: (s: Partial<Settings>) => req<Settings>('PUT', '/api/settings', s),

  listBooks: () => req<Book[]>('GET', '/api/books'),
  getBook: (id: string) => req<Book & { chapters: Chapter[]; job?: JobStats | null }>('GET', `/api/books/${id}`),
  getChapter: (bookId: string, chapterId: string) =>
    req<{ chapter: Chapter; chunks: Chunk[] }>('GET', `/api/books/${bookId}/chapters/${chapterId}`),
  updateBook: (id: string, patch: Record<string, unknown>) => req<Book>('PATCH', `/api/books/${id}`, patch),
  deleteBook: (id: string) => req<{ ok: boolean }>('DELETE', `/api/books/${id}`),
  generate: (id: string) => req<{ jobId?: string; error?: string }>('POST', `/api/books/${id}/generate`),
  pause: (id: string) => req('POST', `/api/books/${id}/pause`),
  cancel: (id: string) => req('POST', `/api/books/${id}/cancel`),
  rechunk: (id: string) => req('POST', `/api/books/${id}/rechunk`),
  renameChapter: (bookId: string, chapterId: string, title: string) =>
    req<{ id: string; title: string }>('PATCH', `/api/books/${bookId}/chapters/${chapterId}`, { title }),
  qaRandom: (id: string) => req<QaSample>('POST', `/api/books/${id}/qa/random`),
  exportBook: (id: string) => req<{ export: { path: string; duration_ms: number; chapter_count: number } }>('POST', `/api/books/${id}/export`),
  listExports: (id: string) => req<Array<{ id: string; path: string; duration_ms: number; created_at: string }>>('GET', `/api/books/${id}/exports`),

  regenerateChunk: (id: string, seed?: string) =>
    req<{ ok: boolean }>('POST', `/api/chunks/${id}/regenerate`, seed ? { seed } : {}),

  listVoices: () => req<Voice[]>('GET', '/api/voices'),
  updateVoice: (id: string, patch: { name?: string; referenceText?: string }) =>
    req<Voice>('PATCH', `/api/voices/${id}`, patch),
  deleteVoice: (id: string) => req<{ ok: boolean }>('DELETE', `/api/voices/${id}`),

  uploadBook: async (file: File): Promise<{ id: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/books', { method: 'POST', body: form });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `${res.status}`);
    }
    return (await res.json()) as { id: string };
  },

  uploadVoice: async (name: string, referenceText: string, file: File): Promise<{ id: string }> => {
    const form = new FormData();
    form.append('name', name);
    form.append('reference_text', referenceText);
    form.append('wav', file);
    const res = await fetch('/api/voices', { method: 'POST', body: form });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `${res.status}`);
    }
    return (await res.json()) as { id: string };
  },

  audioUrl: {
    chunk: (id: string) => `/api/chunks/${id}/audio`,
    chapter: (bookId: string, chapterId: string) => `/api/books/${bookId}/chapters/${chapterId}/audio`,
    voice: (id: string) => `/api/voices/${id}/audio`,
  },
  previewVoice: async (id: string, text: string): Promise<string> => {
    const res = await fetch(`/api/voices/${id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `${res.status}`);
    }
    return URL.createObjectURL(await res.blob());
  },
};

/** Subscribe to server-sent studio events; returns a cleanup function. */
export function onStudioEvent(handler: (ev: { type: string } & Record<string, unknown>) => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    try {
      handler(JSON.parse(m.data));
    } catch {
      /* malformed event — ignore */
    }
  };
  return () => es.close();
}
