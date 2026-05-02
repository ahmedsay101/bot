'use client';
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api.js';

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');
const date = (t) => (t ? new Date(t).toLocaleString() : '—');
const dateShort = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

const reasonChip = (reason, ok) => {
  const map = { take_profit: 'chip-emerald', stop_loss: 'chip-rose', liquidation: 'chip-amber', manual: 'chip-slate' };
  const cls = ok ? (map[reason] || 'chip-slate') : 'chip-rose';
  return (
    <span className={`chip ${cls}`} title={ok ? '' : 'Reason does not match PnL sign'}>
      {reason}{!ok && ' ⚠'}
    </span>
  );
};

export default function TradesPage() {
  const [symbol, setSymbol] = useState('');
  const [limit, setLimit] = useState(100);
  const { data, isLoading } = useQuery({
    queryKey: ['trades', symbol, limit],
    queryFn: () => apiGet('/trades', { symbol: symbol || undefined, limit }),
    refetchInterval: 5000,
  });

  const trades = data || [];
  const stats = useMemo(() => {
    const total = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = trades.filter((t) => (t.pnl || 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl || 0) < 0).length;
    const wr = trades.length ? (wins / trades.length) * 100 : 0;
    return { total, wins, losses, wr };
  }, [trades]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-100">Trade History</h1>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Closed positions · realized PnL</p>
      </div>

      {/* Filters + summary */}
      <div className="card card-pad">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Symbol</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="BTCUSDT"
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Limit</label>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="input">
              {[50, 100, 250, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3 ml-auto text-right">
            <div>
              <div className="text-[10px] uppercase text-slate-500">Net PnL</div>
              <div className={`font-mono font-semibold ${stats.total >= 0 ? 'num-pos' : 'num-neg'}`}>
                {stats.total >= 0 ? '+' : ''}${fmt(stats.total)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">Win Rate</div>
              <div className="font-mono font-semibold text-slate-200">{fmt(stats.wr, 1)}%</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">W / L</div>
              <div className="font-mono">
                <span className="num-pos">{stats.wins}</span>
                <span className="text-slate-600"> / </span>
                <span className="num-neg">{stats.losses}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Desktop table */}
      <div className="card hidden md:block overflow-x-auto">
        <table className="data-table min-w-[1200px]">
          <thead>
            <tr>
              <th>Closed</th>
              <th>Symbol</th>
              <th>Side</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Entry</th>
              <th className="text-right">SL</th>
              <th className="text-right">TP</th>
              <th className="text-right">Exit</th>
              <th className="text-right">Slip</th>
              <th className="text-right">PnL</th>
              <th className="text-right">Fees</th>
              <th>Reason</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={13} className="py-6 text-center text-slate-500">Loading…</td></tr>}
            {!isLoading && trades.length === 0 && (
              <tr><td colSpan={13} className="py-8 text-center text-slate-500">No trades yet</td></tr>
            )}
            {trades.map((t) => {
              const reasonOk =
                (t.reason === 'take_profit' && t.pnl >= 0) ||
                (t.reason === 'stop_loss' && t.pnl <= 0) ||
                (t.reason !== 'take_profit' && t.reason !== 'stop_loss');
              const slippage =
                t.intendedExitPrice != null && Number.isFinite(t.exitPrice)
                  ? t.exitPrice - t.intendedExitPrice : null;
              return (
                <tr key={t._id}>
                  <td className="text-xs text-slate-400 whitespace-nowrap">{dateShort(t.closedAt)}</td>
                  <td className="font-mono font-semibold text-slate-100">{t.symbol}</td>
                  <td><span className={`chip ${t.side === 'LONG' ? 'chip-emerald' : 'chip-rose'}`}>{t.side}</span></td>
                  <td className="text-right font-mono">{fmt(t.qty, 4)}</td>
                  <td className="text-right font-mono">{fmt(t.entryPrice, 4)}</td>
                  <td className="text-right font-mono text-rose-300/80">{fmt(t.stopPrice, 4)}</td>
                  <td className="text-right font-mono text-emerald-300/80">{fmt(t.takeProfitPrice, 4)}</td>
                  <td className="text-right font-mono">{fmt(t.exitPrice, 4)}</td>
                  <td className="text-right font-mono num-mut">
                    {slippage == null ? '—' : (slippage >= 0 ? '+' : '') + fmt(slippage, 4)}
                  </td>
                  <td className={`text-right font-mono font-semibold ${t.pnl >= 0 ? 'num-pos' : 'num-neg'}`}>
                    {t.pnl >= 0 ? '+' : ''}{fmt(t.pnl)}
                  </td>
                  <td className="text-right font-mono num-mut">{fmt(t.fees, 4)}</td>
                  <td>{reasonChip(t.reason, reasonOk)}</td>
                  <td><span className="chip chip-slate uppercase">{t.mode}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {isLoading && <div className="card card-pad text-center text-slate-500 text-sm">Loading…</div>}
        {!isLoading && trades.length === 0 && (
          <div className="card card-pad text-center text-slate-500 text-sm">No trades yet</div>
        )}
        {trades.map((t) => {
          const reasonOk =
            (t.reason === 'take_profit' && t.pnl >= 0) ||
            (t.reason === 'stop_loss' && t.pnl <= 0) ||
            (t.reason !== 'take_profit' && t.reason !== 'stop_loss');
          const slippage =
            t.intendedExitPrice != null && Number.isFinite(t.exitPrice)
              ? t.exitPrice - t.intendedExitPrice : null;
          return (
            <div key={t._id} className="card p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-slate-100">{t.symbol}</span>
                  <span className={`chip ${t.side === 'LONG' ? 'chip-emerald' : 'chip-rose'}`}>{t.side}</span>
                </div>
                <div className={`font-mono font-semibold text-sm ${t.pnl >= 0 ? 'num-pos' : 'num-neg'}`}>
                  {t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
                <div><div className="text-slate-500">Entry</div><div className="font-mono">{fmt(t.entryPrice, 4)}</div></div>
                <div><div className="text-slate-500">Exit</div><div className="font-mono">{fmt(t.exitPrice, 4)}</div></div>
                <div><div className="text-slate-500">Qty</div><div className="font-mono">{fmt(t.qty, 4)}</div></div>
                <div><div className="text-slate-500">SL</div><div className="font-mono text-rose-300/80">{fmt(t.stopPrice, 4)}</div></div>
                <div><div className="text-slate-500">TP</div><div className="font-mono text-emerald-300/80">{fmt(t.takeProfitPrice, 4)}</div></div>
                <div><div className="text-slate-500">Slip</div><div className="font-mono num-mut">{slippage == null ? '—' : (slippage >= 0 ? '+' : '') + fmt(slippage, 4)}</div></div>
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>{date(t.closedAt)}</span>
                {reasonChip(t.reason, reasonOk)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
