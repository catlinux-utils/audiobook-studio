import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, onStudioEvent, type Book, type Chapter, type Chunk, type ChunkQa, type JobStats, type QaSample, type QaSummary, type Voice } from '../lib/api';
import {
  Banner, Button, Card, Checkbox, Input, ProgressBar, QaPill, QaVerdict, Select, StatusBadge, Textarea,
  formatDuration, formatSpan,
} from '../components/bits';

export default function BookDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
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
  const [chapterSizeDraft, setChapterSizeDraft] = useState('');
  const [exports, setExports] = useState<Array<{ id: string; path: string; format: string; duration_ms: number; chapter_count: number; created_at: string; qaSummary: QaSummary | null }>>([]);
  const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set());
  const [exportedNote, setExportedNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // rechunk replaces every chapter id — remember the open chapter's position
  // so the selection can follow it after a re-split
  const chapterIdxRef = useRef(0);

  const refreshBook = useCallback(() => {
    api.getBook(id).then((b) => {
      setBook(b);
      setChapterId((cur) => {
        if (cur && b.chapters.some((c) => c.id === cur)) return cur;
        return b.chapters[cur ? chapterIdxRef.current : 0]?.id ?? b.chapters[0]?.id ?? null;
      });
    }).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  const refreshChapter = useCallback(() => {
    if (!chapterId) return;
    api.getChapter(id, chapterId).then((d) => {
      chapterIdxRef.current = d.chapter.idx;
      setChapterData(d);
    }).catch(() => {
      // stale chapter id (e.g. after a book-level re-chunk) — re-resolve from the book
      setChapterData(null);
      refreshBook();
    });
  }, [id, chapterId, refreshBook]);

  useEffect(() => {
    setChapterSizeDraft(chapterData?.chapter.max_chunk_chars != null ? String(chapterData.chapter.max_chunk_chars) : '');
  }, [chapterData?.chapter.id, chapterData?.chapter.max_chunk_chars]);

  const saveChapterSize = () =>
    act('ch-size', async () => {
      if (!chapterData) return;
      await api.setChapterChunkSize(id, chapterData.chapter.id, chapterSizeDraft.trim() === '' ? null : Number(chapterSizeDraft));
      refreshChapter();
      refreshBook();
    });

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

  /** Re-generate every checked chapter as one job each — done parts are redone too. */
  const regenerateSelectedChapters = async () => {
    const ids = [...selectedChapters];
    const errors: string[] = [];
    for (const cid of ids) {
      try {
        await api.generateChapter(id, cid, true);
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
      const enabled = chapterData
        ? [...selectedChunks].filter((cid) => !chapterData.chunks.find((c) => c.id === cid)?.disabled)
        : [...selectedChunks];
      if (enabled.length === 0) {
        setError('selected parts are all disabled — enable them first');
        return;
      }
      await api.queueChunks(id, enabled);
      setSelectedChunks(new Set());
      refreshBook();
    });

  /** Toggle the disable flag on a set of chunks (skips queue + exports; audio is kept). */
  const setBulkDisabled = (ids: Set<string>, disabled: boolean) => {
    const errors: string[] = [];
    return act('bulk-disable', async () => {
      for (const cid of ids) {
        try {
          await api.setChunkDisabled(cid, disabled);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      setSelectedChunks(new Set());
      refreshChapter();
      refreshBook();
      if (errors.length) setError(errors.join(' · '));
    });
  };

  const saveChapterText = () =>
    act('ch-text', async () => {
      if (!chapterData) return;
      await api.setChapterText(id, chapterData.chapter.id, chapterTextDraft);
      setEditingChapterText(false);
      refreshChapter();
      refreshBook();
    });

  const deleteBook = () => {
    if (!book) return;
    if (!window.confirm(`Delete "${book.title}" and all its audio and exports from disk? This cannot be undone.`)) return;
    act('delete', () => api.deleteBook(id).then(() => navigate('/')));
  };

  if (!book) return <div className="text-zinc-400">{error || 'Loading…'}</div>;

  const doneChunks = book.chunks_done ?? 0;
  const totalChunks = book.chunk_count ?? 0;
  // chapter detail payload has no aggregate columns — derive from the chunk list
  // (disabled parts are skipped by the queue, so they count toward neither side)
  const chapterDone = chapterData ? chapterData.chunks.filter((c) => !c.disabled && c.status === 'done').length : 0;
  const chapterPending = chapterData
    ? chapterData.chunks.filter((c) => !c.disabled && (c.status === 'pending' || c.status === 'failed')).length
    : 0;
  const canGenerate = Boolean(book.voice_id) && doneChunks < totalChunks;

  return (
    <div>
      {/* ---- header ---- */}
      <div className="flex gap-5 mb-6">
        <div className="w-28 h-40 rounded-lg bg-zinc-800 overflow-hidden shrink-0">
          {book.cover_path ? (
            <img src={`/api/books/${book.id}/cover`} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-4xl">📖</div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-zinc-500 mb-1">
            <Link to="/" className="hover:text-zinc-300">← Library</Link>
          </div>
          <div className="flex items-center gap-3 mb-1">
            {editingHeader ? (
              <div className="flex-1 flex flex-wrap gap-2">
                <Input
                  className="flex-1 min-w-[200px] text-lg font-semibold"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="title"
                />
                <Input
                  className="flex-1 min-w-[160px]"
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
                <Button
                  variant="link"
                  size="sm"
                  title="rename book / author"
                  onClick={() => {
                    setEditTitle(book.title);
                    setEditAuthor(book.author);
                    setEditingHeader(true);
                  }}
                >
                  ✏
                </Button>
                <Button variant="danger" size="sm" onClick={deleteBook} title="delete the book with all audio and exports" disabled={busy !== ''}>
                  🗑 delete book
                </Button>
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
          {error && <Banner kind="error" className="mt-3">{error}</Banner>}
          {exportedNote && !error && (
            <Banner kind="success" className="mt-3">
              ✓ {exportedNote} — see Exported audiobooks below
            </Banner>
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
              <QaVerdict qa={spotQa} transcript={spotQa.transcript} />
            </div>
          )}
        </div>
      )}

      {/* ---- exports ---- */}
      {exports.length > 0 && (
        <Card title="Exported audiobooks" className="mb-6">
          <div className="space-y-2">
            {exports.map((x) => (
              <div key={x.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">📕 {x.path.split(/[\\/]/).pop()}</span>
                <span className="text-xs text-zinc-500">
                  <span className="text-zinc-400 uppercase">{x.format}</span> · {x.chapter_count} chapter(s) · {formatDuration(x.duration_ms)} ·{' '}
                  {new Date(x.created_at).toLocaleString()}
                </span>
                {x.qaSummary && <QaPill qa={x.qaSummary} />}
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
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
        {/* ---- chapters + settings column ---- */}
        <div>
          <Card
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
                  <Button
                    variant="ghost"
                    disabled={busy !== '' || !book.voice_id}
                    onClick={regenerateSelectedChapters}
                    title={
                      book.voice_id
                        ? `re-generate all parts of ${selectedChapters.size} selected chapter(s) — existing audio is replaced`
                        : 'assign a voice first'
                    }
                  >
                    ♻ regenerate ({selectedChapters.size})
                  </Button>
                  <Button variant="link" size="sm" onClick={() => setSelectedChapters(new Set())}>
                    ✕
                  </Button>
                </div>
              ) : undefined
            }
          >
            <div className="max-h-[420px] overflow-y-auto space-y-1">
              {book.chapters.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setChapterId(c.id)}
                  className={`w-full rounded-lg px-3 py-2 transition-colors flex items-start gap-2 cursor-pointer select-none ${
                    chapterId === c.id ? 'bg-zinc-700' : 'hover:bg-zinc-800'
                  }`}
                >
                  <Checkbox
                    className="mt-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
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
                      <Input
                        size="sm"
                        className="flex-1"
                        value={editChapterTitle}
                        onChange={(e) => setEditChapterTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            act('chtitle', () => api.renameChapter(id, c.id, editChapterTitle || c.title).then(refreshBook)).then(() => setEditingChapterId(null));
                          }
                        }}
                      />
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() =>
                          act('chtitle', () => api.renameChapter(id, c.id, editChapterTitle || c.title).then(refreshBook)).then(() => setEditingChapterId(null))
                        }
                      >
                        save
                      </Button>
                      <Button variant="link" size="sm" onClick={() => setEditingChapterId(null)}>
                        cancel
                      </Button>
                    </div>
                  ) : (
                    <button onClick={() => setChapterId(c.id)} className="w-full text-left">
                      <div className="text-sm truncate flex items-baseline justify-between gap-2">
                        <span className="truncate">
                          {c.idx + 1}. {c.title}
                        </span>
                        <span
                          className="text-zinc-500 hover:text-zinc-200 text-xs shrink-0"
                          title="rename chapter"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditChapterTitle(c.title);
                            setEditingChapterId(c.id);
                          }}
                        >
                          ✏
                        </span>
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
          </Card>

          <Card title="Voice & params" className="mt-4">
            <label className="block text-xs text-zinc-400 mb-1">Voice</label>
            <Select
              className="w-full mb-3"
              value={book.voice_id ?? ''}
              onChange={(e) => act('voice', () => api.updateBook(id, { voiceId: e.target.value || null })).then(refreshBook)}
            >
              <option value="">— none —</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
            <ParamRow label="Chunk size (chars)" defaultValue={book.max_chunk_chars} onSave={(v) => act('rechunk', () => api.rechunk(id, Number(v)).then(refreshBook))} hint="type a value and press Enter (or 'save') — re-splits all chunks" />
            <ParamRow label="Inference steps" defaultValue={book.num_inference_steps} onSave={(v) => act('steps', () => api.updateBook(id, { numInferenceSteps: v }))} />
            <ParamRow label="Guidance" defaultValue={book.guidance_scale} onSave={(v) => act('guid', () => api.updateBook(id, { guidanceScale: v }))} />
            <ParamRow label="Speed" defaultValue={book.speed} onSave={(v) => act('speed', () => api.updateBook(id, { speed: v }))} />
            <ParamRow label="Seed (blank = random)" defaultValue={book.seed ?? ''} onSave={(v) => act('seed', () => api.updateBook(id, { seed: v || null }))} />
          </Card>
        </div>

        {/* ---- chapter view ---- */}
        <div>
          {chapterData ? (
            <Card
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
                        : `add this chapter to the generation queue (${chapterPending} pending chunks; chapters run one after another)`
                    }
                  >
                    ⚡ queue chapter{chapterPending > 0 ? ` (${chapterPending})` : ''}
                  </Button>
                  {chapterPending === 0 && (
                    <Button
                      variant="ghost"
                      disabled={busy !== '' || !book.voice_id || chapterDone === 0}
                      onClick={() => act('regen-ch', () => api.generateChapter(id, chapterData.chapter.id, true).then(refreshBook))}
                      title={
                        !book.voice_id
                          ? 'assign a voice first'
                          : `re-generate all ${chapterDone} parts of this chapter — existing audio is replaced`
                      }
                    >
                      ♻ regenerate chapter
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={chapterDone === 0}
                    onClick={() => playUrl(api.audioUrl.chapter(id, chapterId!))}
                  >
                    ▶ play whole chapter
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== ''}
                    onClick={() => {
                      setChapterTextDraft(chapterData.chunks.filter((c) => !c.disabled).map((c) => c.text).join('\n\n'));
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
                  <Textarea
                    className="w-full min-h-[220px]"
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
              <div className="flex items-center gap-2 mb-4 text-xs text-zinc-500">
                <span>Part size (chars):</span>
                <input
                  className="w-20 rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs"
                  value={chapterSizeDraft}
                  placeholder={`book default (${book.max_chunk_chars})`}
                  onChange={(e) => setChapterSizeDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveChapterSize()}
                />
                <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={saveChapterSize}>
                  apply — re-splits this chapter
                </Button>
                <span className="text-[11px] text-zinc-600">current chapter only; drops this chapter's audio</span>
              </div>
              {selectedChunks.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-2 rounded-lg bg-emerald-950/40 border border-emerald-900 px-3 py-1.5 text-sm">
                  <span className="text-emerald-300">{selectedChunks.size} part{selectedChunks.size > 1 ? 's' : ''} selected</span>
                  <Button
                    variant="ghost"
                    disabled={busy !== '' || !book.voice_id}
                    onClick={queueSelectedChunks}
                    title={book.voice_id ? 'add the selected parts to the generation queue (selected done parts regenerate)' : 'assign a voice first'}
                  >
                    ⚡ queue selected parts
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== ''}
                    onClick={() => setBulkDisabled(selectedChunks, true)}
                    title="exclude the selected parts from queueing and exports (their audio is kept)"
                  >
                    🚫 disable selected
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== ''}
                    onClick={() => setBulkDisabled(selectedChunks, false)}
                    title="include the selected parts in queueing and exports again"
                  >
                    ✅ enable selected
                  </Button>
                  <Button variant="link" size="sm" onClick={() => setSelectedChunks(new Set())}>
                    ✕ clear
                  </Button>
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
            </Card>
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
  const done = chunks.filter((c) => !c.disabled && c.status === 'done' && c.duration_ms);
  if (done.length === 0) return null;
  const starts = new Map<string, number>();
  let cursor = 0;
  for (const c of chunks) {
    starts.set(c.id, cursor);
    if (!c.disabled && c.status === 'done' && c.duration_ms) cursor += c.duration_ms;
  }
  const total = cursor;
  const totalWeight = chunks.reduce((a, c) => a + (!c.disabled && c.status === 'done' && c.duration_ms ? c.duration_ms : c.text.length), 0);
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
          const weight = !c.disabled && c.status === 'done' && c.duration_ms ? c.duration_ms : c.text.length;
          const cls = c.disabled ? 'bg-zinc-800' : c.queued && c.status === 'pending' ? 'bg-amber-700' : colors[c.status];
          return (
            <div
              key={c.id}
              className={`${cls} ${c.disabled ? '' : 'cursor-pointer'} transition-colors`}
              style={{ width: `${Math.max((weight / totalWeight) * 100, 0.5)}%` }}
              title={`#${c.idx + 1} ${c.disabled ? 'disabled' : c.status} ${formatDuration(c.duration_ms)} — ${c.text.slice(0, 60)}…`}
              onClick={() => !c.disabled && starts.get(c.id) !== undefined && onSeek(starts.get(c.id)!)}
            />
          );
        })}
      </div>
      <div className="text-xs text-zinc-500 mt-1">
        cut map — {chunks.filter((c) => !c.disabled && c.status === 'done').length} generated · total {formatDuration(total)} · click a segment to hear the cut in context
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

  const toggleDisabled = async () => {
    try {
      await api.setChunkDisabled(chunk.id, !chunk.disabled);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${chunk.disabled ? 'border-zinc-800 bg-zinc-950/60 opacity-60' : chunk.status === 'failed' ? 'border-red-900 bg-red-950/40' : 'border-zinc-800 bg-zinc-900/70'}`}>
      <div className="flex items-center gap-2 mb-1">
        {onToggleSelect && (
          <Checkbox
            className="shrink-0"
            checked={selected ?? false}
            onChange={onToggleSelect}
            title="select this part for queueing"
          />
        )}
        <span className="text-xs text-zinc-500 w-12">#{chunk.idx + 1}</span>
        {chunk.disabled && <StatusBadge status="disabled" />}
        <StatusBadge status={chunk.status} />
        {chunk.queued && chunk.status === 'pending' && (
          <span className="rounded px-1.5 py-0.5 text-[10px] bg-amber-950 text-amber-400 border border-amber-900">⏳ in queue</span>
        )}
        <span className="text-xs text-zinc-500">{formatDuration(chunk.duration_ms)}</span>
        <span className="text-xs text-zinc-600">
          chars {chunk.char_start}–{chunk.char_end}
        </span>
        {chunk.status === 'done' && (
          <Button variant="link" size="sm" className="text-emerald-400" onClick={onPlay}>
            ▶ play
          </Button>
        )}
        {chunk.status === 'done' && (
          <Button variant="link" size="sm" className="text-sky-400" onClick={checkWords} disabled={qaBusy}>
            {qaBusy ? 'checking…' : '🔤 check words'}
          </Button>
        )}
        {chunk.status !== 'generating' && (
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setDraft(chunk.text);
              setEditing(true);
            }}
            title="fix the text — audio of the old text is dropped"
          >
            ✏ edit
          </Button>
        )}
        {chunk.status !== 'generating' && (
          <Button
            variant="link"
            size="sm"
            disabled={regenerating}
            onClick={() => regenerate()}
            title="regenerate this part immediately"
          >
            {regenerating ? 'generating…' : '♻ regenerate'}
          </Button>
        )}
        {chunk.status !== 'generating' && (
          <Button
            variant="link"
            size="sm"
            className="text-zinc-500"
            onClick={() => setShowSeed((s) => !s)}
            title="regenerate with a specific seed"
          >
            🎲
          </Button>
        )}
        {chunk.status !== 'generating' && (
          <Button
            variant="link"
            size="sm"
            className={chunk.disabled ? 'text-emerald-400' : 'text-zinc-500'}
            onClick={toggleDisabled}
            title={
              chunk.disabled
                ? 'include this part in queueing and exports again'
                : 'exclude this part from queueing and exports (audio is kept; the flag is lost if the chapter text is re-split)'
            }
          >
            {chunk.disabled ? '✅ enable' : '🚫 disable'}
          </Button>
        )}
      </div>
      {editing ? (
        <div className="mt-1">
          <Textarea
            className="w-full border-yellow-700 min-h-[90px]"
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
          <QaVerdict qa={qa} transcript={qa.transcript} />
        </div>
      )}
      {showSeed && (
        <div className="flex items-center gap-2 mt-2">
          <Input
            size="sm"
            className="w-32"
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

function ParamRow({ label, defaultValue, onSave, hint }: { label: string; defaultValue: number | string; onSave: (v: number | string) => void; hint?: string }) {
  const [value, setValue] = useState(String(defaultValue));
  const [dirty, setDirty] = useState(false);
  useEffect(() => setValue(String(defaultValue)), [defaultValue]);
  const numeric = typeof defaultValue === 'number';
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400 flex-1">{label}</label>
        <Input
          size="sm"
          className={`w-24 ${dirty ? 'border-yellow-600' : ''}`}
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
          <Button
            variant="link"
            size="sm"
            className="text-emerald-400"
            onClick={() => {
              onSave(numeric ? Number(value) : value);
              setDirty(false);
            }}
          >
            save
          </Button>
        )}
      </div>
      {hint && <div className="text-[10px] text-zinc-600">{hint}</div>}
    </div>
  );
}
