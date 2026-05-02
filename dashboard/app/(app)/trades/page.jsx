'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api.js';

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');
const date = (t) => (t ? new Date(t).toLocaleString() : '—');

export default function TradesPage() {
  const [symbol, setSymbol] = useState('');
  const [limit, setLimit] = useState(100);
  const { data, isLoading } = useQuery({
    queryKey: ['trades', symbol, limit],
    queryFn: () => apiGet('/trades', { symbol: symbol || undefined, limit }),
    refetchInterval: 5000,
  });

  const trades = data || [];
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Symbol</label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="BTCUSDT"
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Limit</label>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
          >
            {[50, 100, 250, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto text-sm text-slate-400">
          Net PnL:{' '}
          <span className={totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {totalPnl >= 0 ? '+' : ''}${fmt(totalPnl)}
          </span>
        </div>
      </div>

      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left py-2 px-3">Closed</th>
              <th className="text-left">Symbol</th>
              <th className="text-left">Side</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Entry</th>
              <th className="text-right">Exit</th>
              <th className="text-right">PnL</th>
              <th className="text-right">Fees</th>
              <th className="text-left">Reason</th>
              <th className="text-left">Mode</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={10} className="py-4 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {trades.map((t) => (
              <tr key={t._id} className="border-t border-slate-800">
                <td className="py-2 px-3 text-xs text-slate-400">{date(t.closedAt)}</td>
                <td className="font-mono">{t.symbol}</td>
                <td className={t.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}>{t.side}</td>
                <td className="text-right font-mono">{fmt(t.qty, 4)}</td>
                <td className="text-right font-mono">{fmt(t.entryPrice, 4)}</td>
                <td className="text-right font-mono">{fmt(t.exitPrice, 4)}</td>
                <td className={`text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {t.pnl >= 0 ? '+' : ''}
                  {fmt(t.pnl)}
                </td>
                <td className="text-right font-mono text-slate-500">{fmt(t.fees, 4)}</td>
                <td className="text-xs text-slate-400">{t.reason}</td>
                <td className="text-xs text-slate-500">{t.mode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
