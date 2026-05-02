export default function StatCard({ label, value, sub, color = 'sky', icon = null, trend = null }) {
  const accentMap = {
    sky:     { text: 'text-sky-300',     glow: 'from-sky-500/20',     bar: 'bg-sky-400' },
    emerald: { text: 'text-emerald-300', glow: 'from-emerald-500/20', bar: 'bg-emerald-400' },
    rose:    { text: 'text-rose-300',    glow: 'from-rose-500/20',    bar: 'bg-rose-400' },
    amber:   { text: 'text-amber-300',   glow: 'from-amber-500/20',   bar: 'bg-amber-400' },
    slate:   { text: 'text-slate-200',   glow: 'from-slate-500/10',   bar: 'bg-slate-400' },
  };
  const a = accentMap[color] || accentMap.sky;

  return (
    <div className="card card-hover relative overflow-hidden p-4 sm:p-5">
      {/* Accent glow */}
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${a.glow} via-transparent to-transparent opacity-60`} />
      {/* Left accent bar */}
      <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded-r ${a.bar} opacity-70`} />

      <div className="relative flex items-start justify-between gap-2">
        <div className="card-title">{label}</div>
        {icon && <div className={`${a.text} opacity-70`}>{icon}</div>}
      </div>
      <div className={`relative mt-2 text-[22px] sm:text-2xl font-semibold leading-tight ${a.text} font-mono`}>
        {value}
      </div>
      {(sub || trend) && (
        <div className="relative mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
          {trend && (
            <span className={trend >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {trend >= 0 ? '▲' : '▼'} {Math.abs(trend).toFixed(2)}%
            </span>
          )}
          {sub && <span className="truncate">{sub}</span>}
        </div>
      )}
    </div>
  );
}
