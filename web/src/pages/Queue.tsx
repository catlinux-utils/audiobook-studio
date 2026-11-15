import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, onStudioEvent, type Book, type Stats } from '../lib/api';
import { Button, ProgressBar, StatCard, StatusBadge, formatDuration, formatSpan } from '../components/bits';

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

  const active = books.filter((b) => ['generating', 'queued', 'paused'].includes(b.status));
  const recent = books.filter((b) => !active.includes(b));
  const jobFor = (bookId: string) => stats?.jobs.find((j) => j.bookId === bookId);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Queue</h1>
      {error && <div className="mb-4 rounded-lg bg-red-950 border border-red-800 text-red-200 px-4 py-2 text-sm">{error}</div>}

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
      {active.length === 0 && <div className="rounded-xl border border-dashed border-zinc-700 p-8 text-center text-zinc-400 mb-6">Nothing generating. Start a book from its detail page.</div>}
      <div className="space-y-3 mb-8">
        {active.map((b) => (
          <div key={b.id} className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
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
                if (!j || j.state !== 'running') return null;
                return (
                  <span className="text-xs text-blue-300">
                    {j.speedFactor ? `${j.speedFactor.toFixed(2)}× realtime` : ''}
                    {j.etaMs ? ` · ETA ${formatSpan(j.etaMs)}` : ''}
                  </span>
                );
              })()}
              <div className="ml-auto flex gap-2">
                {b.status === 'generating' ? (
                  <Button onClick={() => api.pause(b.id).then(refresh)}>⏸ Pause</Button>
                ) : (
                  <Button variant="primary" onClick={() => api.generate(b.id).then(refresh).catch((e) => setError(String(e.message ?? e)))}>▶ Resume</Button>
                )}
                <Button variant="danger" onClick={() => api.cancel(b.id).then(refresh)}>Cancel</Button>
              </div>
            </div>
            <ProgressBar done={b.chunks_done ?? 0} total={b.chunk_count ?? 0} failed={b.chunks_failed ?? 0} />
          </div>
        ))}
      </div>

      <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide mb-2">Finished</h2>
      <div className="space-y-2">
        {recent.map((b) => (
          <div key={b.id} className="rounded-xl bg-zinc-900/60 border border-zinc-800 p-3 flex items-center gap-3">
            <Link to={`/books/${b.id}`} className="font-medium hover:underline flex-1 truncate">
              {b.title}
            </Link>
            <StatusBadge status={b.status} />
            <span className="text-xs text-zinc-500">
              {b.chunks_done ?? 0}/{b.chunk_count ?? 0} · {formatDuration(b.duration_ms)}
            </span>
          </div>
        ))}
        {recent.length === 0 && <div className="text-zinc-500 text-sm">—</div>}
      </div>
    </div>
  );
}
