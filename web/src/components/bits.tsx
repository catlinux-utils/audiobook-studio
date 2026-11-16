/** Small shared UI atoms — the canonical styles for the whole app. */

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: 'bg-zinc-700 text-zinc-300',
    queued: 'bg-yellow-800 text-yellow-200',
    generating: 'bg-blue-800 text-blue-200',
    paused: 'bg-orange-800 text-orange-200',
    done: 'bg-emerald-800 text-emerald-200',
    pending: 'bg-zinc-700 text-zinc-400',
    disabled: 'bg-zinc-800 border border-zinc-600 text-zinc-400',
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

/** Wall-clock span in human units ("4m 12s", "1h 03m"). */
export function formatSpan(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function SectionTitle({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`text-sm font-semibold text-zinc-300 uppercase tracking-wide ${className}`}>{children}</h2>;
}

/** Standard content card; `title` renders the shared SectionTitle header. */
export function Card({ title, right, children, className = '' }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-3">
          {title ? <SectionTitle>{title}</SectionTitle> : <span />}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/** Inline message strip; replaces the per-page hand-rolled error/success/note banners. */
export function Banner({ kind, children, className = '' }: { kind: 'error' | 'success' | 'note' | 'warning'; children: React.ReactNode; className?: string }) {
  const styles = {
    error: 'bg-red-950 border-red-800 text-red-200',
    success: 'bg-emerald-950 border-emerald-800 text-emerald-200',
    note: 'bg-zinc-900 border-zinc-700 text-zinc-300',
    warning: 'bg-amber-950/40 border-amber-800 text-amber-200',
  };
  return <div className={`rounded-lg border px-4 py-2 text-sm ${styles[kind]} ${className}`}>{children}</div>;
}

const FIELD_SM = 'rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs';
const FIELD_MD = 'rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm';

type FieldSize = 'sm' | 'md';

export function Input({ size = 'md', className = '', ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: FieldSize }) {
  return <input {...rest} className={`${size === 'sm' ? FIELD_SM : FIELD_MD} ${className}`} />;
}

export function Textarea({ size = 'md', className = '', ...rest }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> & { size?: FieldSize }) {
  return <textarea {...rest} className={`${size === 'sm' ? FIELD_SM : FIELD_MD} ${className}`} />;
}

export function Select({ size = 'md', className = '', ...rest }: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: FieldSize }) {
  return <select {...rest} className={`${size === 'sm' ? FIELD_SM : FIELD_MD} ${className}`} />;
}

export function Checkbox({ className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" {...rest} className={`accent-emerald-500 ${className}`} />;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  title,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'link';
  size?: 'md' | 'sm';
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const styles = {
    default: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-100',
    primary: 'bg-emerald-700 hover:bg-emerald-600 text-white',
    danger: 'bg-red-900 hover:bg-red-800 text-red-100',
    ghost: 'bg-transparent hover:bg-zinc-800 text-zinc-300',
    link: 'bg-transparent hover:underline text-xs px-1 py-0',
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${className} ${
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'
      } ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

/** Single missing/extra word chip used by every QA verdict display. */
export function WordChip({ word, kind }: { word: string; kind: 'missing' | 'extra' }) {
  const styles =
    kind === 'missing'
      ? 'bg-red-950 border-red-900 text-red-300'
      : 'bg-amber-950/60 border-amber-900 text-amber-300';
  return <span className={`inline-block rounded border px-1.5 py-0.5 mr-1 mb-0.5 ${styles}`}>{word}</span>;
}

/** Shared QA verdict block: missing/extra word chips + ASR transcript. */
export function QaVerdict({ qa, transcript }: { qa: { missing: string[]; extra: string[]; sourceWords: number }; transcript?: string }) {
  if (qa.missing.length === 0 && qa.extra.length === 0) {
    return <div className="text-emerald-400">✓ all {qa.sourceWords} words present in the audio</div>;
  }
  return (
    <div className="space-y-1">
      {qa.missing.length > 0 && (
        <div>
          <span className="text-red-400 font-medium">missing:</span>{' '}
          {qa.missing.map((m, i) => <WordChip key={i} word={m} kind="missing" />)}
        </div>
      )}
      {qa.extra.length > 0 && (
        <div>
          <span className="text-amber-400 font-medium">not in text:</span>{' '}
          {qa.extra.map((m, i) => <WordChip key={i} word={m} kind="extra" />)}
        </div>
      )}
      {transcript !== undefined && (
        <div className="text-zinc-500">
          ASR heard: <span className="text-zinc-400">{transcript}</span>
        </div>
      )}
    </div>
  );
}

/** Amber/emerald "QA x/y clean" pill for exports. */
export function QaPill({ qa }: { qa: { checked: number; flagged: number; missingWords: number; wer?: number | null } }) {
  return (
    <span
      className={`text-xs rounded px-1.5 py-0.5 border ${
        qa.flagged > 0 ? 'bg-amber-950/60 border-amber-900 text-amber-300' : 'bg-emerald-950/60 border-emerald-900 text-emerald-300'
      }`}
      title={`${qa.missingWords} missing word(s) · WER ${(100 * (qa.wer ?? 0)).toFixed(1)}%`}
    >
      QA {qa.checked - qa.flagged}/{qa.checked} clean
    </span>
  );
}
