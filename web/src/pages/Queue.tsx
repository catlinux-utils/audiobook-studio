import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, onStudioEvent, type Book } from '../lib/api';
import { Button, ProgressBar, StatusBadge, formatDuration } from '../components/bits';

export default function Queue() {
  const [books, setBooks] = useState<Book[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api.listBooks().then(setBooks).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    return onStudioEvent((ev) => {
      if (ev.type === 'job.update' || ev.type === 'book.update' || ev.type === 'chunk.update') refresh();
    });
  }, [refresh]);

  const active = books.filter((b) => ['generating', 'queued', 'paused'].includes(b.status));
  const recent = books.filter((b) => !active.includes(b));

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Queue</h1>
      {error && <div className="mb-4 rounded-lg bg-red-950 border border-red-800 text-red-200 px-4 py-2 text-sm">{error}</div>}

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
