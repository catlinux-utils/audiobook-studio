import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, onStudioEvent, type Book, type Chapter, type Chunk, type ChunkQa, type JobStats, type QaSample, type QaSummary, type Voice } from '../lib/api';
import { Button, ProgressBar, StatusBadge, formatDuration, formatSpan } from '../components/bits';

export default function BookDetail() {
  const { id = '' } = useParams();
  const [book, setBook] = useState<(Book & { chapters: Chapter[]; job?: JobStats | null }) | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [chapterData, setChapterData] = useState<{ chapter: Chapter; chunks: Chunk[] } | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [qa, setQa] = useState<QaSample | null>(null);
  const [spotQa, setSpotQa] = useState<ChunkQa | null>(null);
  const [qaBusy, setQaBusy] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editingHeader, setEditingHeader] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editChapterTitle, setEditChapterTitle] = useState('');
  const [editingChapterText, setEditingChapterText] = useState(false);
  const [chapterTextDraft, setChapterTextDraft] = useState('');
  const [exports, setExports] = useState<Array<{ id: string; path: string; format: string; duration_ms: number; chapter_count: number; created_at: string; qaSummary: QaSummary | null }>>([]);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set());
  const [exportedNote, setExportedNote] = useState<string | null>(null);
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
    api.listExports(id).then(setExports).catch(() => setExports([]));
    const off = onStudioEvent((ev) => {
      if (ev.type === 'book.update' || ev.type === 'job.update') {
        refreshBook();
        api.listExports(id).then(setExports).catch(() => undefined);
      }
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

  // chunk selections belong to the visible chapter — reset on switch
  useEffect(() => {
    setSelectedChunks(new Set());
  }, [chapterId]);

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
    setSpotQa(null);
    try {
      const sample = await api.qaRandom(id);
      setQa(sample);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const checkWords = async () => {
    if (!qa) return;
    setQaBusy(true);
    setError('');
    try {
      setSpotQa(await api.chunkQa(qa.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setQaBusy(false);
    }
  };

  /** Queue every checked chapter, in list order; already-queued ones are skipped. */
  const queueSelectedChapters = async () => {
    const ids = [...selectedChapters];
    const errors: string[] = [];
    for (const cid of ids) {
      try {
        await api.generateChapter(id, cid);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    setSelectedChapters(new Set());
    refreshBook();
    if (errors.length) setError(errors.join(' · '));
  };

  /** Queue the checked parts of this chapter as one job (done parts regenerate). */
  const queueSelectedChunks = () =>
    act('queue-sel', async () => {
      await api.queueChunks(id, [...selectedChunks]);
      setSelectedChunks(new Set());
      refreshBook();
    });

  const saveChapterText = () =>
    act('ch-text', async () => {
      if (!chapterData) return;
      await api.setChapterText(id, chapterData.chapter.id, chapterTextDraft);
      setEditingChapterText(false);
      refreshChapter();
      refreshBook();
    });

  if (!book) return <div className="text-zinc-400">{error || 'Loading…'}</div>;

  const doneChunks = book.chunks_done ?? 0;
  const totalChunks = book.chunk_count ?? 0;
  // pending (or retryable) chunks of the currently selected chapter
  const chapterPending = chapterData ? chapterData.chapter.chunk_count - chapterData.chapter.chunks_done : 0;
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
            {editingHeader ? (
              <div className="flex-1 flex flex-wrap gap-2">
                <input
                  className="flex-1 min-w-[200px] rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-lg font-semibold"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="title"
                />
                <input
                  className="flex-1 min-w-[160px] rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm"
                  value={editAuthor}
                  onChange={(e) => setEditAuthor(e.target.value)}
                  placeholder="author"
                />
                <Button
                  variant="primary"
                  onClick={() =>
                    act('meta', () =>
                      api.updateBook(id, { title: editTitle || book.title, author: editAuthor }).then(() => {
                        setEditingHeader(false);
                        refreshBook();
                      }),
                    )
                  }
                >
                  save
                </Button>
                <Button variant="ghost" onClick={() => setEditingHeader(false)}>
                  cancel
                </Button>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-semibold truncate">{book.title}</h1>
                <StatusBadge status={book.status} />
                <button
                  className="text-zinc-500 hover:text-zinc-200 text-sm"
                  title="rename book / author"
                  onClick={() => {
                    setEditTitle(book.title);
                    setEditAuthor(book.author);
                    setEditingHeader(true);
                  }}
                >
                  ✏
                </button>
              </>
            )}
          </div>
          {!editingHeader && <div className="text-zinc-400 mb-3">{book.author || '—'}</div>}
          <ProgressBar done={doneChunks} total={totalChunks} failed={book.chunks_failed ?? 0} />
          <div className="flex items-center gap-4 text-sm text-zinc-400 mt-1 mb-3">
            <span>
              {doneChunks}/{totalChunks} chunks
              {(book.chunks_failed ?? 0) > 0 && <span className="text-red-400"> · {book.chunks_failed} failed</span>}
            </span>
            <span>total audio: {formatDuration(book.duration_ms)}</span>
            {book.job && book.job.state === 'running' && book.job.speedFactor && (
              <span className="text-blue-300">
                {book.job.chapterTitle && <span className="text-blue-400/80">{book.job.chapterTitle} · </span>}
                {book.job.done}/{book.job.total} chunks in job · {book.job.speedFactor.toFixed(2)}× realtime
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
          {exportedNote && !error && (
            <div className="mt-3 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-200 px-3 py-1.5 text-sm">
              ✓ {exportedNote} — see Exported audiobooks below
            </div>
          )}
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
            <Button variant="ghost" onClick={checkWords} disabled={qaBusy}>
              {qaBusy ? 'checking…' : '🔤 check words'}
            </Button>
            {qa.prevChunkId && <Button variant="ghost" onClick={() => playUrl(api.audioUrl.chunk(qa.prevChunkId!))}>◀ prev chunk</Button>}
            {qa.nextChunkId && <Button variant="ghost" onClick={() => playUrl(api.audioUrl.chunk(qa.nextChunkId!))}>next chunk ▶</Button>}
          </div>
          {spotQa && (
            <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs space-y-1">
              {spotQa.missing.length === 0 && spotQa.extra.length === 0 ? (
                <div className="text-emerald-400">✓ all {spotQa.sourceWords} words present in the audio</div>
              ) : (
                <div className="space-y-1">
                  {spotQa.missing.length > 0 && (
                    <div>
                      <span className="text-red-400 font-medium">missing:</span>{' '}
                      {spotQa.missing.map((m, i) => (
                        <span key={i} className="inline-block rounded bg-red-950 border border-red-900 text-red-300 px-1.5 py-0.5 mr-1 mb-0.5">
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                  {spotQa.extra.length > 0 && (
                    <div>
                      <span className="text-amber-400 font-medium">not in text:</span>{' '}
                      {spotQa.extra.map((m, i) => (
                        <span key={i} className="inline-block rounded bg-amber-950/60 border border-amber-900 text-amber-300 px-1.5 py-0.5 mr-1 mb-0.5">
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-zinc-500">
                    ASR heard: <span className="text-zinc-400">{spotQa.transcript}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- exports ---- */}
      {exports.length > 0 && (
        <div className="mb-6 rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-3">Exported audiobooks</h2>
          <div className="space-y-2">
            {exports.map((x) => (
              <div key={x.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">📕 {x.path.split(/[\\/]/).pop()}</span>
                <span className="text-xs text-zinc-500">
                  <span className="text-zinc-400 uppercase">{x.format}</span> · {x.chapter_count} chapter(s) · {formatDuration(x.duration_ms)} ·{' '}
                  {new Date(x.created_at).toLocaleString()}
                </span>
                {x.qaSummary && (
                  <span
                    className={`text-xs rounded px-1.5 py-0.5 border ${
                      x.qaSummary.flagged > 0
                        ? 'bg-amber-950/60 border-amber-900 text-amber-300'
                        : 'bg-emerald-950/60 border-emerald-900 text-emerald-300'
                    }`}
                    title={`${x.qaSummary.missingWords} missing word(s) · WER ${(100 * (x.qaSummary.wer ?? 0)).toFixed(1)}%`}
                  >
                    QA {x.qaSummary.checked - x.qaSummary.flagged}/{x.qaSummary.checked} clean
                  </span>
                )}
                <a href={`/api/exports/${x.id}/download`} className="ml-auto text-emerald-400 hover:underline">
                  ⬇ download
                </a>
                {x.qaSummary && (
                  <a href={`/api/exports/${x.id}/report`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline text-xs" title="opens in a new tab">
                    QA report
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* ---- chapters + settings column ---- */}
        <div>
          <Panel
            title="Chapters"
            right={
              selectedChapters.size > 0 ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy !== '' || !book.voice_id}
                    onClick={queueSelectedChapters}
                    title={book.voice_id ? `add ${selectedChapters.size} selected chapter(s) to the generation queue` : 'assign a voice first'}
                  >
                    ⚡ queue selected ({selectedChapters.size})
                  </Button>
                  <button className="text-xs text-zinc-400 hover:underline" onClick={() => setSelectedChapters(new Set())}>
                    ✕
                  </button>
                </div>
              ) : undefined
            }
          >
            <div className="max-h-[420px] overflow-y-auto space-y-1">
              {book.chapters.map((c) => (
                <div
                  key={c.id}
                  className={`w-full rounded-lg px-3 py-2 transition-colors flex items-start gap-2 ${
                    chapterId === c.id ? 'bg-zinc-700' : 'hover:bg-zinc-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0 accent-emerald-500"
                    checked={selectedChapters.has(c.id)}
                    onChange={() =>
                      setSelectedChapters((s) => {
                        const next = new Set(s);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                    title="select for queueing"
                  />
                  <div className="flex-1 min-w-0">
                  {editingChapterId === c.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="flex-1 rounded bg-zinc-800 border border-zinc-600 px-2 py-1 text-sm"
                        value={editChapterTitle}
                        onChange={(e) => setEditChapterTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            act('chtitle', () => api.renameChapter(id, c.id, editChapterTitle || c.title).then(refreshBook)).then(() => setEditingChapterId(null));
                          }
                        }}
                      />
                      <button
                        className="text-xs text-emerald-400 hover:underline"
                        onClick={() =>
                          act('chtitle', () => api.renameChapter(id, c.id, editChapterTitle || c.title).then(refreshBook)).then(() => setEditingChapterId(null))
                        }
                      >
                        save
                      </button>
                      <button className="text-xs text-zinc-400 hover:underline" onClick={() => setEditingChapterId(null)}>
                        cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setChapterId(c.id)} className="w-full text-left">
                      <div className="text-sm truncate flex items-baseline justify-between gap-2">
                        <span className="truncate">
                          {c.idx + 1}. {c.title}
                        </span>
                        <button
                          className="text-zinc-500 hover:text-zinc-200 text-xs shrink-0"
                          title="rename chapter"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditChapterTitle(c.title);
                            setEditingChapterId(c.id);
                          }}
                        >
                          ✏
                        </button>
                      </div>
                    </button>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <ProgressBar done={c.chunks_done} total={c.chunk_count} failed={c.chunks_failed} />
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {c.chunks_done}/{c.chunk_count} · {formatDuration(c.duration_ms)}
                    {c.chunks_failed > 0 && <span className="text-red-400"> · {c.chunks_failed} failed</span>}
                  </div>
                  </div>
                </div>
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
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy !== '' || !book.voice_id || chapterPending === 0}
                    onClick={() => act('queue-ch', () => api.generateChapter(id, chapterData.chapter.id).then(refreshBook))}
                    title={
                      !book.voice_id
                        ? 'assign a voice first'
                        : chapterPending === 0
                          ? 'this chapter has no pending chunks'
                          : `add this chapter to the generation queue (${chapterPending} chunks; chapters run one after another)`
                    }
                  >
                    ⚡ queue chapter{chapterPending > 0 ? ` (${chapterPending})` : ''}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={chapterData.chunks.filter((c) => c.status === 'done').length === 0}
                    onClick={() => playUrl(api.audioUrl.chapter(id, chapterId!))}
                  >
                    ▶ play whole chapter
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== ''}
                    onClick={() => {
                      setChapterTextDraft(chapterData.chunks.map((c) => c.text).join('\n\n'));
                      setEditingChapterText(true);
                    }}
                    title="edit the chapter's full text (re-splits into parts)"
                  >
                    ✏ text
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== '' || chapterData.chunks.every((c) => c.status !== 'done')}
                    onClick={() =>
                      act('export-ch', () =>
                        api.exportChapter(id, chapterData.chapter.id).then((r) => {
                          refreshBook();
                          const clean = r.qa.checked - r.qa.flagged;
                          setExportedNote(
                            (r.parts < r.total ? `exported ${r.parts}/${r.total} generated parts · ` : '') +
                              (r.qa.flagged > 0
                                ? `word check: ${clean}/${r.qa.checked} parts clean, ${r.qa.flagged} with missing words (WER ${(100 * (r.qa.wer ?? 0)).toFixed(1)}%)`
                                : `word check: all ${r.qa.checked} parts clean`),
                          );
                          setTimeout(() => setExportedNote(null), 10000);
                        }),
                      )
                    }
                    title={
                      chapterData.chunks.some((c) => c.status === 'done')
                        ? `export the ${chapterData.chunks.filter((c) => c.status === 'done').length} generated part(s) as one MP3`
                        : 'nothing generated in this chapter yet'
                    }
                  >
                    ⬇ export chapter
                  </Button>
                </div>
              }
            >
              {editingChapterText && (
                <div className="mb-3 rounded-lg border border-yellow-800 bg-yellow-950/20 p-3">
                  <textarea
                    className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm min-h-[220px]"
                    value={chapterTextDraft}
                    onChange={(e) => setChapterTextDraft(e.target.value)}
                    placeholder="chapter text…"
                  />
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <Button variant="primary" disabled={busy !== '' || chapterTextDraft.trim() === ''} onClick={saveChapterText}>
                      {busy === 'ch-text' ? 'saving…' : '💾 save & re-split'}
                    </Button>
                    <Button variant="ghost" onClick={() => setEditingChapterText(false)}>cancel</Button>
                    <span className="text-xs text-amber-400">
                      re-splits the chapter into new parts
                      {chapterData.chunks.some((c) => c.status === 'done') &&
                        ` — ${chapterData.chunks.filter((c) => c.status === 'done').length} generated part(s) will be dropped`}
                    </span>
                  </div>
                </div>
              )}
              {chapterData.chunks.length > 0 && <ChunkTimeline chunks={chapterData.chunks} onSeek={(ms) => seekChapter(ms)} />}
              <audio ref={audioRef} controls className="w-full mt-3 mb-4" />
              {selectedChunks.size > 0 && (
                <div className="flex items-center gap-2 mb-2 rounded-lg bg-emerald-950/40 border border-emerald-900 px-3 py-1.5 text-sm">
                  <span className="text-emerald-300">{selectedChunks.size} part{selectedChunks.size > 1 ? 's' : ''} selected</span>
                  <Button
                    variant="ghost"
                    disabled={busy !== '' || !book.voice_id}
                    onClick={queueSelectedChunks}
                    title={book.voice_id ? 'add the selected parts to the generation queue (selected done parts regenerate)' : 'assign a voice first'}
                  >
                    ⚡ queue selected parts
                  </Button>
                  <button className="text-xs text-zinc-400 hover:underline" onClick={() => setSelectedChunks(new Set())}>
                    ✕ clear
                  </button>
                </div>
              )}
              <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
                {chapterData.chunks.map((chunk) => (
                  <ChunkRow
                    key={chunk.id}
                    chunk={chunk}
                    selected={selectedChunks.has(chunk.id)}
                    onToggleSelect={() =>
                      setSelectedChunks((s) => {
                        const next = new Set(s);
                        if (next.has(chunk.id)) next.delete(chunk.id);
                        else next.add(chunk.id);
                        return next;
                      })
                    }
                    onPlay={() => playUrl(api.audioUrl.chunk(chunk.id))}
                    onChanged={refreshChapter}
                    onError={setError}
                  />
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

function ChunkRow({
  chunk,
  onPlay,
  onChanged,
  onError,
  selected,
  onToggleSelect,
}: {
  chunk: Chunk;
  onPlay: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [seed, setSeed] = useState('');
  const [qa, setQa] = useState<ChunkQa | null>(null);
  const [qaBusy, setQaBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chunk.text);
  const [saving, setSaving] = useState(false);

  const regenerate = async (withSeed?: string) => {
    setRegenerating(true);
    try {
      await api.regenerateChunk(chunk.id, withSeed || undefined);
      setQa(null); // old verdict no longer applies to new audio
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
      setShowSeed(false);
    }
  };

  const checkWords = async () => {
    setQaBusy(true);
    try {
      setQa(await api.chunkQa(chunk.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setQaBusy(false);
    }
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await api.editChunk(chunk.id, draft);
      setEditing(false);
      setQa(null); // verdict referred to the old text/audio
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${chunk.status === 'failed' ? 'border-red-900 bg-red-950/40' : 'border-zinc-800 bg-zinc-900/70'}`}>
      <div className="flex items-center gap-2 mb-1">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="shrink-0 accent-emerald-500"
            checked={selected ?? false}
            onChange={onToggleSelect}
            title="select this part for queueing"
          />
        )}
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
        {chunk.status === 'done' && (
          <button className="text-xs text-sky-400 hover:underline" onClick={checkWords} disabled={qaBusy}>
            {qaBusy ? 'checking…' : '🔤 check words'}
          </button>
        )}
        {chunk.status !== 'generating' && (
          <button
            className="text-xs text-zinc-400 hover:underline"
            onClick={() => {
              setDraft(chunk.text);
              setEditing(true);
            }}
            title="fix the text — audio of the old text is dropped"
          >
            ✏ edit
          </button>
        )}
        {chunk.status !== 'generating' && (
          <button className="text-xs text-zinc-400 hover:underline" onClick={() => setShowSeed((s) => !s)}>
            ♻ regenerate
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-1">
          <textarea
            className="w-full rounded bg-zinc-800 border border-yellow-700 px-2 py-1.5 text-sm min-h-[90px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <Button variant="primary" disabled={saving || draft.trim() === ''} onClick={saveEdit}>
              {saving ? 'saving…' : 'save text'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>cancel</Button>
            {chunk.status === 'done' && (
              <span className="text-[10px] text-amber-400">saving drops this part's generated audio — it will need regenerating</span>
            )}
          </div>
        </div>
      ) : (
        <div className="text-zinc-300 whitespace-pre-wrap leading-snug">{chunk.text}</div>
      )}
      {chunk.error && <div className="text-xs text-red-400 mt-1">{chunk.error}</div>}
      {qa && (
        <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs space-y-1">
          {qa.missing.length === 0 && qa.extra.length === 0 ? (
            <div className="text-emerald-400">✓ all {qa.sourceWords} words present in the audio</div>
          ) : (
            <div className="space-y-1">
              {qa.missing.length > 0 && (
                <div>
                  <span className="text-red-400 font-medium">missing:</span>{' '}
                  {qa.missing.map((m, i) => (
                    <span key={i} className="inline-block rounded bg-red-950 border border-red-900 text-red-300 px-1.5 py-0.5 mr-1 mb-0.5">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              {qa.extra.length > 0 && (
                <div>
                  <span className="text-amber-400 font-medium">not in text:</span>{' '}
                  {qa.extra.map((m, i) => (
                    <span key={i} className="inline-block rounded bg-amber-950/60 border border-amber-900 text-amber-300 px-1.5 py-0.5 mr-1 mb-0.5">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-zinc-500">
                ASR heard: <span className="text-zinc-400">{qa.transcript}</span>
              </div>
            </div>
          )}
        </div>
      )}
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
