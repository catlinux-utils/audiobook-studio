/** Small shared UI atoms. */

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: 'bg-zinc-700 text-zinc-300',
    queued: 'bg-yellow-800 text-yellow-200',
    generating: 'bg-blue-800 text-blue-200',
    paused: 'bg-orange-800 text-orange-200',
    done: 'bg-emerald-800 text-emerald-200',
    pending: 'bg-zinc-700 text-zinc-400',
    failed: 'bg-red-900 text-red-200',
  };
  return (
    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${styles[status] ?? styles['draft']}`}>
      {status}
    </span>
  );
}

export function ProgressBar({ done, total, failed = 0 }: { done: number; total: number; failed?: number }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  const failedPct = total > 0 ? (failed / total) * 100 : 0;
  return (
    <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden flex">
      <div className="h-full bg-emerald-600 transition-all" style={{ width: `${pct}%` }} />
      <div className="h-full bg-red-700 transition-all" style={{ width: `${failedPct}%` }} />
    </div>
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    default: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-100',
    primary: 'bg-emerald-700 hover:bg-emerald-600 text-white',
    danger: 'bg-red-900 hover:bg-red-800 text-red-100',
    ghost: 'bg-transparent hover:bg-zinc-800 text-zinc-300',
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {children}
    </button>
  );
}
