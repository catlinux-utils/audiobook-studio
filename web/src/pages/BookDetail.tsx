import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, onStudioEvent, type Book, type Chapter, type Chunk, type JobStats, type QaSample, type Voice } from '../lib/api';
import { Button, ProgressBar, StatusBadge, formatDuration, formatSpan } from '../components/bits';

export default function BookDetail() {
  const { id = '' } = useParams();
  const [book, setBook] = useState<(Book & { chapters: Chapter[]; job?: JobStats | null }) | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [chapterData, setChapterData] = useState<{ chapter: Chapter; chunks: Chunk[] } | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [qa, setQa] = useState<QaSample | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);

  const refreshBook = useCallback(() => {
    api.getBook(id).then((b) => {
      setBook(b);
      setChapterId((cur) => cur ?? b.chapters[0]?.id ?? null);
    }).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  const refreshChapter = useCallback(() => {
    if (!chapterId) return;
    api.getChapter(id, chapterId).then(setChapterData).catch(() => setChapterData(null));
  }, [id, chapterId]);

  useEffect(() => {
    refreshBook();
    api.listVoices().then(setVoices).catch(() => setVoices([]));
    const off = onStudioEvent((ev) => {
      if (ev.type === 'book.update' || ev.type === 'job.update') refreshBook();
      if (ev.type === 'chunk.update' && (ev.bookId === id || ev.chapterId === chapterId)) {
        refreshChapter();
        refreshBook();
      }
    });
    return off;
  }, [id, chapterId, refreshBook, refreshChapter]);

  useEffect(() => {
    refreshChapter();
  }, [chapterId, refreshChapter]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const spotCheck = async () => {
    setBusy('qa');
    setError('');
    try {
      const sample = await api.qaRandom(id);
      setQa(sample);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!book) return <div className="text-zinc-400">{error || 'Loading…'}</div>;

  const doneChunks = book.chunks_done ?? 0;
  const totalChunks = book.chunk_count ?? 0;
  const canGenerate = Boolean(book.voice_id) && doneChunks < totalChunks;

  return (
    <div>
      {/* ---- header ---- */}
      <div className="flex gap-5 mb-6">
        <div className="w-28 h-40 rounded-lg bg-zinc-800 overflow-hidden shrink-0">
          {book.cover_path ? (
            <img src={api.audioUrl.chapter === undefined ? '' : `/api/books/${book.id}/cover`} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-4xl">📖</div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold truncate">{book.title}</h1>
            <StatusBadge status={book.status} />
          </div>
          <div className="text-zinc-400 mb-3">{book.author || '—'}</div>
          <ProgressBar done={doneChunks} total={totalChunks} failed={book.chunks_failed ?? 0} />
          <div className="flex items-center gap-4 text-sm text-zinc-400 mt-1 mb-3">
            <span>
              {doneChunks}/{totalChunks} chunks
              {(book.chunks_failed ?? 0) > 0 && <span className="text-red-400"> · {book.chunks_failed} failed</span>}
            </span>
            <span>total audio: {formatDuration(book.duration_ms)}</span>
            {book.job && book.job.state === 'running' && book.job.speedFactor && (
              <span className="text-blue-300">
                {book.job.speedFactor.toFixed(2)}× realtime
                {book.job.etaMs ? ` · ETA ${formatSpan(book.job.etaMs)}` : ''}
              </span>
            )}
            {book.job && book.job.wallMs > 0 && (
              <span className="text-zinc-500">{formatSpan(book.job.wallMs)} compute</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {book.status !== 'generating' ? (
              <Button variant="primary" disabled={!canGenerate || busy !== ''} onClick={() => act('gen', () => api.generate(id))} title={book.voice_id ? '' : 'assign a voice first'}>
                {book.status === 'paused' ? '▶ Resume' : '▶ Generate'}
              </Button>
            ) : (
              <Button onClick={() => act('pause', () => api.pause(id))}>⏸ Pause</Button>
            )}
            {book.status === 'generating' || book.status === 'paused' ? (
              <Button variant="danger" onClick={() => act('cancel', () => api.cancel(id))}>Cancel</Button>
            ) : null}
            <Button
              disabled={busy !== '' || doneChunks === 0}
              onClick={() => act('export', async () => {
                await api.exportBook(id);
                refreshBook();
              })}
              title="Assemble chapters into a chaptered .m4b"
            >
              {busy === 'export' ? 'Exporting…' : '⬇ Export M4B'}
            </Button>
            <Button variant="ghost" onClick={spotCheck} disabled={busy !== '' || doneChunks === 0}>
              🎲 Spot-check
            </Button>
            <Button variant="ghost" disabled={busy !== ''} onClick={() => act('rechunk', () => api.rechunk(id))} title="Re-split chapter text into chunks (drops generated audio)">
              ♻ Re-chunk
            </Button>
          </div>
          {error && <div className="mt-3 rounded-lg bg-red-950 border border-red-800 text-red-200 px-3 py-1.5 text-sm">{error}</div>}
        </div>
      </div>

      {/* ---- qa sample card ---- */}
      {qa && (
        <div className="mb-6 rounded-xl border border-emerald-800/60 bg-emerald-950/30 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-emerald-300">
              Random sample · chapter {qa.chapter_idx + 1} ({qa.chapter_title}) · chunk #{qa.idx + 1} · {formatDuration(qa.duration_ms)}
            </div>
            <Button variant="ghost" onClick={spotCheck}>🎲 another</Button>
          </div>
          <p className="text-sm text-zinc-300 mb-3 whitespace-pre-wrap">{qa.text}</p>
          <div className="flex gap-2">
            <Button onClick={() => playUrl(api.audioUrl.chunk(qa.id))}>▶ play sample</Button>
            {qa.prevChunkId && <Button variant="ghost" onClick={() => playUrl(api.audioUrl.chunk(qa.prevChunkId!))}>◀ prev chunk</Button>}
            {qa.nextChunkId && <Button variant="ghost" onClick={() => playUrl(api.audioUrl.chunk(qa.nextChunkId!))}>next chunk ▶</Button>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* ---- chapters + settings column ---- */}
        <div>
          <Panel title="Chapters">
            <div className="max-h-[420px] overflow-y-auto space-y-1">
              {book.chapters.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChapterId(c.id)}
                  className={`w-full text-left rounded-lg px-3 py-2 transition-colors ${
                    chapterId === c.id ? 'bg-zinc-700' : 'hover:bg-zinc-800'
                  }`}
                >
                  <div className="text-sm truncate">
                    {c.idx + 1}. {c.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <ProgressBar done={c.chunks_done} total={c.chunk_count} failed={c.chunks_failed} />
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {c.chunks_done}/{c.chunk_count} · {formatDuration(c.duration_ms)}
                    {c.chunks_failed > 0 && <span className="text-red-400"> · {c.chunks_failed} failed</span>}
                  </div>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Voice & params" className="mt-4">
            <label className="block text-xs text-zinc-400 mb-1">Voice</label>
            <select
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm mb-3"
              value={book.voice_id ?? ''}
              onChange={(e) => act('voice', () => api.updateBook(id, { voiceId: e.target.value || null })).then(refreshBook)}
            >
              <option value="">— none —</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <ParamRow label="Chunk size (chars)" defaultValue={book.max_chunk_chars} onSave={(v) => act('rechunk', () => api.updateBook(id, { maxChunkChars: v, force: true }).then(refreshBook))} hint="changing this re-splits all chunks" />
            <ParamRow label="Inference steps" defaultValue={book.num_inference_steps} onSave={(v) => act('steps', () => api.updateBook(id, { numInferenceSteps: v }))} />
            <ParamRow label="Guidance" defaultValue={book.guidance_scale} onSave={(v) => act('guid', () => api.updateBook(id, { guidanceScale: v }))} />
            <ParamRow label="Speed" defaultValue={book.speed} onSave={(v) => act('speed', () => api.updateBook(id, { speed: v }))} />
            <ParamRow label="Seed (blank = random)" defaultValue={book.seed ?? ''} onSave={(v) => act('seed', () => api.updateBook(id, { seed: v || null }))} />
          </Panel>
        </div>

        {/* ---- chapter view ---- */}
        <div>
          {chapterData ? (
            <Panel
              title={`${chapterData.chapter.idx + 1}. ${chapterData.chapter.title}`}
              right={
                <Button
                  variant="ghost"
                  disabled={chapterData.chunks.filter((c) => c.status === 'done').length === 0}
                  onClick={() => playUrl(api.audioUrl.chapter(id, chapterId!))}
                >
                  ▶ play whole chapter
                </Button>
              }
            >
              {chapterData.chunks.length > 0 && <ChunkTimeline chunks={chapterData.chunks} onSeek={(ms) => seekChapter(ms)} />}
              <audio ref={audioRef} controls className="w-full mt-3 mb-4" />
              <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
                {chapterData.chunks.map((chunk) => (
                  <ChunkRow key={chunk.id} chunk={chunk} onPlay={() => playUrl(api.audioUrl.chunk(chunk.id))} onChanged={refreshChapter} onError={setError} />
                ))}
              </div>
            </Panel>
          ) : (
            <div className="text-zinc-500">Select a chapter.</div>
          )}
        </div>
      </div>
    </div>
  );

  function playUrl(url: string) {
    const el = audioRef.current;
    if (!el) return;
    el.src = url;
    void el.play();
  }

  function seekChapter(ms: number) {
    const el = audioRef.current;
    if (!el) return;
    const url = api.audioUrl.chapter(id, chapterId!);
    if (!el.src.endsWith(url)) {
      el.src = url;
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = ms / 1000;
        void el.play();
      }, { once: true });
      el.load();
    } else {
      el.currentTime = ms / 1000;
      void el.play();
    }
  }
}

/* ---------- chunk timeline: visual cut-point map ---------- */

function ChunkTimeline({ chunks, onSeek }: { chunks: Chunk[]; onSeek: (ms: number) => void }) {
  const done = chunks.filter((c) => c.status === 'done' && c.duration_ms);
  if (done.length === 0) return null;
  const starts = new Map<string, number>();
  let cursor = 0;
  for (const c of chunks) {
    starts.set(c.id, cursor);
    if (c.status === 'done' && c.duration_ms) cursor += c.duration_ms;
  }
  const total = cursor;
  const totalWeight = chunks.reduce((a, c) => a + (c.status === 'done' && c.duration_ms ? c.duration_ms : c.text.length), 0);
  const colors: Record<string, string> = {
    done: 'bg-emerald-600 hover:bg-emerald-500',
    failed: 'bg-red-700 hover:bg-red-600',
    pending: 'bg-zinc-700',
    generating: 'bg-blue-600 animate-pulse',
  };
  return (
    <div>
      <div className="flex h-6 w-full rounded-md overflow-hidden gap-px bg-zinc-900" title="each segment = one chunk; click to jump into the chapter audio">
        {chunks.map((c) => {
          const weight = c.status === 'done' && c.duration_ms ? c.duration_ms : c.text.length;
          return (
            <div
              key={c.id}
              className={`${colors[c.status]} cursor-pointer transition-colors`}
              style={{ width: `${Math.max((weight / totalWeight) * 100, 0.5)}%` }}
              title={`#${c.idx + 1} ${c.status} ${formatDuration(c.duration_ms)} — ${c.text.slice(0, 60)}…`}
              onClick={() => starts.get(c.id) !== undefined && onSeek(starts.get(c.id)!)}
            />
          );
        })}
      </div>
      <div className="text-xs text-zinc-500 mt-1">
        cut map — {chunks.filter((c) => c.status === 'done').length} generated · total {formatDuration(total)} · click a segment to hear the cut in context
      </div>
    </div>
  );
}

/* ---------- single chunk row ---------- */

function ChunkRow({ chunk, onPlay, onChanged, onError }: { chunk: Chunk; onPlay: () => void; onChanged: () => void; onError: (msg: string) => void }) {
  const [regenerating, setRegenerating] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [seed, setSeed] = useState('');

  const regenerate = async (withSeed?: string) => {
    setRegenerating(true);
    try {
      await api.regenerateChunk(chunk.id, withSeed || undefined);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
      setShowSeed(false);
    }
  };

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${chunk.status === 'failed' ? 'border-red-900 bg-red-950/40' : 'border-zinc-800 bg-zinc-900/70'}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-zinc-500 w-12">#{chunk.idx + 1}</span>
        <StatusBadge status={chunk.status} />
        <span className="text-xs text-zinc-500">{formatDuration(chunk.duration_ms)}</span>
        <span className="text-xs text-zinc-600">
          chars {chunk.char_start}–{chunk.char_end}
        </span>
        {chunk.status === 'done' && (
          <button className="text-xs text-emerald-400 hover:underline ml-auto" onClick={onPlay}>
            ▶ play
          </button>
        )}
        {chunk.status !== 'generating' && (
          <button className="text-xs text-zinc-400 hover:underline" onClick={() => setShowSeed((s) => !s)}>
            ♻ regenerate
          </button>
        )}
      </div>
      <div className="text-zinc-300 whitespace-pre-wrap leading-snug">{chunk.text}</div>
      {chunk.error && <div className="text-xs text-red-400 mt-1">{chunk.error}</div>}
      {showSeed && (
        <div className="flex items-center gap-2 mt-2">
          <input
            className="rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs w-32"
            placeholder="seed (blank = book)"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
          <Button disabled={regenerating} onClick={() => regenerate(seed || undefined)}>
            {regenerating ? 'generating…' : 'regenerate now'}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------- misc ---------- */

function Panel({ title, children, right, className = '' }: { title: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function ParamRow({ label, defaultValue, onSave, hint }: { label: string; defaultValue: number | string; onSave: (v: number | string) => void; hint?: string }) {
  const [value, setValue] = useState(String(defaultValue));
  const [dirty, setDirty] = useState(false);
  useEffect(() => setValue(String(defaultValue)), [defaultValue]);
  const numeric = typeof defaultValue === 'number';
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400 flex-1">{label}</label>
        <input
          className={`w-24 rounded bg-zinc-800 border px-2 py-1 text-xs ${dirty ? 'border-yellow-600' : 'border-zinc-700'}`}
          value={value}
          inputMode={numeric ? 'decimal' : 'text'}
          onChange={(e) => {
            setValue(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSave(numeric ? Number(value) : value);
              setDirty(false);
            }
          }}
        />
        {dirty && (
          <button
            className="text-xs text-emerald-400 hover:underline"
            onClick={() => {
              onSave(numeric ? Number(value) : value);
              setDirty(false);
            }}
          >
            save
          </button>
        )}
      </div>
      {hint && <div className="text-[10px] text-zinc-600">{hint}</div>}
    </div>
  );
}
