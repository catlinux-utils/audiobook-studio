import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, onStudioEvent, type Book } from '../lib/api';
import { Button, ProgressBar, StatusBadge, formatDuration } from '../components/bits';

export default function Library() {
  const [books, setBooks] = useState<Book[]>([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.listBooks().then(setBooks).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    return onStudioEvent((ev) => {
      if (ev.type === 'job.update' || ev.type === 'book.update' || ev.type === 'chunk.update') refresh();
    });
  }, [refresh]);

  const upload = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const { id } = await api.uploadBook(file);
      navigate(`/books/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Library</h1>
        <input
          ref={fileRef}
          type="file"
          accept=".epub,.txt"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
        <Button variant="primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? 'Ingesting…' : '+ Add book (EPUB / TXT)'}
        </Button>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-950 border border-red-800 text-red-200 px-4 py-2 text-sm">{error}</div>}

      {books.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
          No books yet. Add an EPUB or TXT to get started — try one of the bundled <code>sample-books/</code>.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {books.map((b) => (
            <div
              key={b.id}
              className="rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-600 transition-colors cursor-pointer overflow-hidden flex"
              onClick={() => navigate(`/books/${b.id}`)}
            >
              <div className="w-20 shrink-0 bg-zinc-800">
                {b.cover_path ? (
                  <img
                    src={`/api/books/${b.id}/cover`}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                      e.currentTarget.parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center text-3xl">📖</div>';
                    }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-3xl">📖</div>
                )}
              </div>
              <div className="p-3 flex-1 min-w-0">
                <div className="font-medium truncate">{b.title}</div>
                <div className="text-sm text-zinc-400 truncate mb-2">{b.author || '—'}</div>
                <div className="flex items-center gap-2 mb-2">
                  <StatusBadge status={b.status} />
                  <span className="text-xs text-zinc-500">{b.voice_name ?? 'no voice'}</span>
                </div>
                <ProgressBar done={b.chunks_done ?? 0} total={b.chunk_count ?? 0} failed={b.chunks_failed ?? 0} />
                <div className="flex justify-between text-xs text-zinc-500 mt-1">
                  <span>
                    {b.chunks_done ?? 0}/{b.chunk_count ?? 0} chunks
                    {(b.chunks_failed ?? 0) > 0 && <span className="text-red-400"> · {b.chunks_failed} failed</span>}
                  </span>
                  <span>{formatDuration(b.duration_ms)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
