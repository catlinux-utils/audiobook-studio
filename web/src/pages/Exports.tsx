import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ExportRow } from '../lib/api';
import { Button, formatDuration } from '../components/bits';

/** Every export across all books, with Discord-friendly compression. */
export default function Exports() {
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    api.listAllExports().then(setRows).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const compress = async (row: ExportRow) => {
    const targetMB = Number(targets[row.id]) || 20;
    setBusyId(row.id);
    setError('');
    try {
      const r = await api.compressExport(row.id, targetMB);
      refresh();
      setNote(
        r.fitsTarget
          ? `compressed "${row.path.split(/[\\/]/).pop()}" to ${mb(r.export.sizeBytes ?? 0)} (${r.bitrateKbps} kbps) — fits under ${r.targetMB} MB`
          : `re-encoded at the 16 kbps floor — ${mb(r.export.sizeBytes ?? 0)} (too long to fit under ${r.targetMB} MB; split the book for that)`,
      );
      setTimeout(() => setNote(''), 10000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const estimateKbps = (row: ExportRow, targetMB: number) =>
    row.durationMs > 0 ? Math.floor(((targetMB * 1024 * 1024 * 0.96 * 8) / 1000) / (row.durationMs / 1000)) : 0;

  if (!rows) return <div className="text-zinc-400">{error || 'Loading…'}</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Exports</h1>
        <Button variant="ghost" onClick={refresh}>↺ refresh</Button>
      </div>
      {error && <div className="mb-4 rounded-lg bg-red-950 border border-red-800 text-red-200 px-4 py-2 text-sm">{error}</div>}
      {note && <div className="mb-4 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-200 px-4 py-2 text-sm">✓ {note}</div>}

      {rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-zinc-400">
          Nothing exported yet — export a chapter or a whole book from its page.
        </div>
      )}

      <div className="space-y-2">
        {rows.map((x) => {
          const targetMB = Number(targets[x.id]) || 20;
          const kbps = estimateKbps(x, targetMB);
          const feasible = kbps >= 16;
          return (
            <div key={x.id} className="rounded-xl bg-zinc-900 border border-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-zinc-400 uppercase text-xs w-9">{x.format}</span>
                <span className="font-medium truncate max-w-[380px]" title={x.path}>{x.path.split(/[\\/]/).pop()}</span>
                <Link to={`/books/${x.bookId}`} className="text-xs text-zinc-500 hover:text-zinc-300 hover:underline truncate max-w-[220px]">
                  {x.bookTitle}
                </Link>
                <span className="text-xs text-zinc-500">
                  {x.chapterCount} ch · {formatDuration(x.durationMs)} · {x.sizeBytes !== null ? mb(x.sizeBytes) : 'missing'}
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
                <span className="ml-auto flex items-center gap-2">
                  <a href={`/api/exports/${x.id}/download`} className="text-emerald-400 hover:underline">⬇ download</a>
                  {x.qaSummary && (
                    <a href={`/api/exports/${x.id}/report`} className="text-sky-400 hover:underline text-xs">⬇ QA report</a>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-zinc-500">
                <span>compress for Discord:</span>
                <input
                  className="w-16 rounded bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-xs"
                  value={targets[x.id] ?? '20'}
                  onChange={(e) => setTargets((t) => ({ ...t, [x.id]: e.target.value }))}
                  title="target size in MB"
                />
                <span>MB</span>
                <span className={feasible ? '' : 'text-amber-400'}>
                  {feasible ? `≈ ${kbps} kbps ${x.format === 'm4b' ? '(chapters + cover kept)' : ''}` : `≈ ${kbps} kbps — below the 16 kbps floor, cannot fit (split needed)`}
                </span>
                <Button
                  variant="ghost"
                  disabled={busyId !== null || x.sizeBytes === null}
                  onClick={() => compress(x)}
                  title={x.sizeBytes === null ? 'file missing on disk' : 're-encode to the target size'}
                >
                  {busyId === x.id ? 'compressing…' : '🗜 compress'}
                </Button>
                {x.sizeBytes !== null && x.sizeBytes <= targetMB * 1024 * 1024 && (
                  <span className="text-emerald-500">already under {targetMB} MB</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
