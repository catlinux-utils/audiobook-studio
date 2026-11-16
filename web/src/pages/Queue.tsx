import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, onStudioEvent, type Book, type Stats } from '../lib/api';
import { Banner, Button, Card, ProgressBar, StatCard, StatusBadge, formatDuration, formatSpan } from '../components/bits';

export default function Queue() {
  const [books, setBooks] = useState<Book[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api.listBooks().then(setBooks).catch((e) => setError(String(e.message ?? e)));
    api.getStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    refresh();
    return onStudioEvent((ev) => {
      if (ev.type === 'job.update' || ev.type === 'book.update' || ev.type === 'chunk.update') refresh();
    });
  }, [refresh]);

  // Active = the worker is actually on it or work is queued/paused for it.
  // A canceled/paused book with no open job has stopped work → Recent instead.
  const isOpen = (b: Book) => ['generating', 'queued'].includes(b.status) || (b.open_jobs ?? 0) > 0;
  const active = books.filter(isOpen);
  const recent = books.filter((b) => !isOpen(b));
  const jobFor = (bookId: string) => stats?.jobs.find((j) => j.bookId === bookId);
  // every action triggers a book.update event anyway; the catch surfaces API
  // errors that would otherwise vanish into an unhandled rejection
  const queueAction = (fn: () => Promise<unknown>) =>
    fn()
      .then(refresh)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Queue</h1>
      {error && <Banner kind="error" className="mb-4">{error}</Banner>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatCard label="Audio generated" value={formatDuration(stats.lifetime.audio_ms)} sub={`${stats.lifetime.books} book(s)`} />
          <StatCard
            label="Generation speed"
            value={stats.lifetime.speedFactor ? `${stats.lifetime.speedFactor.toFixed(2)}×` : '—'}
            sub="realtime, across all jobs"
          />
          <StatCard label="Chunks generated" value={String(stats.lifetime.chunks_done)} sub={`${formatSpan(stats.lifetime.genWallMs)} of compute`} />
          <StatCard
            label="Failed chunks"
            value={String(stats.lifetime.chunks_failed)}
            sub={stats.lifetime.chunks_failed > 0 ? 'retryable from book page' : 'none'}
          />
        </div>
      )}

      <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-2">Active</h2>
      {stats && stats.regens.length > 0 && (
        <div className="space-y-2 mb-4">
          {stats.regens.map((r) => (
            <div key={r.chunkId} className="rounded-xl bg-blue-950/40 border border-blue-900 p-3 flex items-center gap-3">
              <span className="text-blue-300 text-sm font-medium">♻ Regenerating</span>
              <StatusBadge status="generating" />
              <Link to={`/books/${r.bookId}`} className="text-sm hover:underline truncate flex-1">
                {r.bookTitle} — chapter {r.chapterIdx} ({r.chapterTitle}), chunk #{r.chunkIdx}
              </Link>
              <span className="text-xs text-zinc-500">{r.state}</span>
            </div>
          ))}
        </div>
      )}
      {active.length === 0 && <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center text-zinc-400 mb-6">Nothing generating. Start a book from its detail page.</div>}
      <div className="space-y-3 mb-8">
        {active.map((b) => (
          <Card key={b.id}>
            <div className="flex items-center gap-3 mb-2">
              <Link to={`/books/${b.id}`} className="font-medium hover:underline">
                {b.title}
              </Link>
              <StatusBadge status={b.status} />
              <span className="text-xs text-zinc-500">
                {b.chunks_done ?? 0}/{b.chunk_count ?? 0} · {formatDuration(b.duration_ms)}
              </span>
              {(() => {
                const j = jobFor(b.id);
                if (!j) return null;
                if (j.state === 'queued') {
                  return (
                    <span className="text-xs text-amber-300">
                      ⏳ {j.chapterTitle ? `${j.chapterTitle} queued` : 'queued'}
                    </span>
                  );
                }
                if (j.state !== 'running') return null;
                return (
                  <span className="text-xs text-blue-300">
                    {j.chapterTitle && <span className="text-blue-400/80">{j.chapterTitle} · </span>}
                    {j.speedFactor ? `${j.speedFactor.toFixed(2)}× realtime` : ''}
                    {j.etaMs ? ` · ETA ${formatSpan(j.etaMs)}` : ''}
                  </span>
                );
              })()}
              <div className="ml-auto flex gap-2">
                {b.status === 'generating' && (
                  <Button onClick={() => queueAction(() => api.pause(b.id))}>⏸ Pause</Button>
                )}
                {b.status === 'paused' && (
                  <Button variant="primary" onClick={() => queueAction(() => api.generate(b.id))}>▶ Resume</Button>
                )}
                {['generating', 'queued', 'paused'].includes(b.status) && (
                  <Button variant="danger" onClick={() => queueAction(() => api.cancel(b.id))} title="stop generation and cancel all queued work for this book — it leaves this list">
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          <ProgressBar done={b.chunks_done ?? 0} total={b.chunk_count ?? 0} failed={b.chunks_failed ?? 0} />
          </Card>
        ))}
      </div>

      <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-2">Finished</h2>
      <div className="space-y-2">
        {recent.map((b) => (
          <Card key={b.id} className="p-3! flex items-center gap-3">
            <Link to={`/books/${b.id}`} className="font-medium hover:underline flex-1 truncate">
              {b.title}
            </Link>
            <StatusBadge status={b.status} />
            <span className="text-xs text-zinc-500">
              {b.chunks_done ?? 0}/{b.chunk_count ?? 0} · {formatDuration(b.duration_ms)}
            </span>
          </Card>
        ))}
        {recent.length === 0 && <div className="text-zinc-500 text-sm">—</div>}
      </div>
    </div>
  );
}
