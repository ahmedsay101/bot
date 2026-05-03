'use client';

const STATE_STYLES = {
  GRID: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  HEDGE: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  RESET: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');
const fmtPct = (n, d = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '—';
const fmtMs = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

function RangeBar({ snap }) {
  const lo = snap.lowerBand;
  const hi = snap.upperBand;
  const px = snap.currentPrice;
  if (!(lo > 0 && hi > lo)) return <div className="text-[11px] text-slate-500">no range</div>;
  const span = hi - lo;
  // Clamp the marker inside the bar but show direction badge if outside.
  const inside = px >= lo && px <= hi;
  const pct = inside ? ((px - lo) / span) * 100 : px > hi ? 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1 font-mono">
        <span className="text-rose-400/80">L {fmt(lo, 4)}</span>
        <span className={inside ? 'text-sky-300' : 'text-amber-400'}>
          {inside ? 'in range' : px > hi ? 'above' : 'below'} · {fmt(px, 4)}
        </span>
        <span className="text-emerald-400/80">U {fmt(hi, 4)}</span>
      </div>
      <div className="relative h-3 rounded-md overflow-hidden bg-slate-800/60 border border-slate-700/60">
        {/* level ticks */}
        {snap.levels?.map((l, i) => {
          const lp = ((l.price - lo) / span) * 100;
          if (lp < 0 || lp > 100) return null;
          return (
            <div
              key={i}
              className={`absolute top-0 bottom-0 w-px ${
                l.side === 'BUY' ? 'bg-emerald-400/30' : 'bg-rose-400/30'
              }`}
              style={{ left: `${lp}%` }}
            />
          );
        })}
        {/* current price marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.7)]"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 mt-1">
        <span>range {fmtPct(snap.rangePercent)}</span>
        <span>{snap.levels?.length ?? 0} levels</span>
      </div>
    </div>
  );
}

const EVENT_COLORS = {
  STATE_CHANGE: 'text-sky-300',
  RANGE_BUILT: 'text-slate-300',
  GRID_PLACED: 'text-emerald-300',
  GRID_FILLED: 'text-emerald-400',
  GRID_TP_FILLED: 'text-emerald-400',
  BREAKOUT_DETECTED: 'text-amber-400',
  HEDGE_OPENED: 'text-amber-300',
  HEDGE_CLOSED: 'text-amber-300',
  TREND_CONFIRMED: 'text-rose-400',
  FAKE_BREAKOUT: 'text-emerald-300',
  CHOP_DETECTED: 'text-rose-300',
  RESET_TRIGGERED: 'text-slate-300',
  COOLDOWN_DONE: 'text-slate-400',
  ERROR: 'text-rose-400',
};

export default function GridSymbolCard({ snap }) {
  const stateClass = STATE_STYLES[snap.state] || STATE_STYLES.RESET;
  const events = (snap.recentEvents || []).slice().reverse();
  return (
    <div className="card card-pad space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="font-mono font-semibold text-slate-100 text-base">{snap.symbol}</div>
          <span className={`text-[11px] font-bold tracking-widest px-2 py-0.5 rounded border ${stateClass}`}>
            {snap.state}
          </span>
          {snap.breakoutDetected && (
            <span className="text-[10px] text-amber-300 font-mono">
              breakout {snap.breakoutDirection}
            </span>
          )}
          {snap.cooldownRemainingMs > 0 && (
            <span className="text-[10px] text-slate-400 font-mono">
              cooldown {fmtMs(snap.cooldownRemainingMs)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <span className="text-slate-500">net</span>
          <span className={snap.netPosition > 0 ? 'text-emerald-300' : snap.netPosition < 0 ? 'text-rose-300' : 'text-slate-400'}>
            {snap.netPosition > 0 ? '+' : ''}{fmt(snap.netPosition, 4)}
          </span>
          <span className="text-slate-600">·</span>
          <span className="text-emerald-300">L {snap.openLongPositions}</span>
          <span className="text-rose-300">S {snap.openShortPositions}</span>
        </div>
      </div>

      <RangeBar snap={snap} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="border border-slate-800 rounded-lg p-3 bg-slate-900/30">
          <div className="text-[11px] text-slate-500 mb-2">
            Grid Positions ({snap.totalOpenPositions})
          </div>
          {snap.positions.length === 0 ? (
            <div className="text-[11px] text-slate-600">no open grid positions</div>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead className="text-slate-500">
                <tr>
                  <th className="text-left">Side</th>
                  <th className="text-right">Size</th>
                  <th className="text-right">Entry</th>
                  <th className="text-right">TP</th>
                </tr>
              </thead>
              <tbody>
                {snap.positions.map((p, i) => (
                  <tr key={i} className="border-t border-slate-800/60">
                    <td className={p.side === 'LONG' ? 'text-emerald-300' : 'text-rose-300'}>{p.side}</td>
                    <td className="text-right">{fmt(p.size, 4)}</td>
                    <td className="text-right">{fmt(p.entryPrice, 4)}</td>
                    <td className="text-right text-emerald-300/80">{fmt(p.tpPrice, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 pt-2 border-t border-slate-800/60 text-[11px] text-slate-500">
            Hedge:{' '}
            {snap.hedge ? (
              <span className="font-mono">
                <span className={snap.hedge.side === 'LONG' ? 'text-emerald-300' : 'text-rose-300'}>
                  {snap.hedge.side}
                </span>
                {' '}qty {fmt(snap.hedge.size, 4)} @ {fmt(snap.hedge.entryPrice, 4)}
              </span>
            ) : (
              <span className="text-slate-600">none</span>
            )}
          </div>
        </div>

        <div className="border border-slate-800 rounded-lg p-3 bg-slate-900/30">
          <div className="text-[11px] text-slate-500 mb-2">Events</div>
          {events.length === 0 ? (
            <div className="text-[11px] text-slate-600">no events yet</div>
          ) : (
            <ul className="text-[11px] font-mono space-y-1 max-h-48 overflow-y-auto">
              {events.slice(0, 25).map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-slate-600 shrink-0">
                    {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className={`shrink-0 ${EVENT_COLORS[e.type] || 'text-slate-300'}`}>
                    {e.type}
                  </span>
                  <span className="text-slate-400 truncate">{e.msg}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
