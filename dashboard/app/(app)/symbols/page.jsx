'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api.js';

const fmt = (n, d = 4) => (typeof n === 'number' ? n.toFixed(d) : '—');

export default function SymbolsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['scan'],
    queryFn: () => apiGet('/symbols/scan'),
    refetchInterval: 10_000,
  });
  if (isLoading) return <div className="text-slate-400">Loading…</div>;
  if (!data) return <div className="text-slate-500">No scan data yet.</div>;

  const candidates = data.candidates || [];
  return (
    <div className="space-y-6">
      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-300 mb-2">
          Selected ({data.selected?.length || 0})
        </h2>
        <div className="flex flex-wrap gap-2">
          {(data.selected || []).map((s) => (
            <Link
              key={s}
              href={`/strategy/${s}`}
              className="px-3 py-1 bg-sky-500/20 text-sky-300 text-sm rounded hover:bg-sky-500/30"
            >
              {s}
            </Link>
          ))}
        </div>
        <div className="text-xs text-slate-500 mt-2">
          Last scan: {data.scannedAt ? new Date(data.scannedAt).toLocaleString() : '—'}
        </div>
      </div>

      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4 overflow-x-auto">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Candidates</h2>
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left py-2">Symbol</th>
              <th className="text-left">Regime</th>
              <th className="text-right">ATR</th>
              <th className="text-right">RSI</th>
              <th className="text-right">|Slope|</th>
              <th className="text-right">Score</th>
              <th className="text-left">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.symbol} className="border-t border-slate-800">
                <td className="py-2 font-mono">{c.symbol}</td>
                <td>
                  <span
                    className={
                      c.regime === 'RANGE'
                        ? 'text-emerald-400'
                        : c.regime === 'TREND'
                        ? 'text-amber-400'
                        : 'text-slate-500'
                    }
                  >
                    {c.regime}
                  </span>
                </td>
                <td className="text-right font-mono">{fmt(c.atr, 4)}</td>
                <td className="text-right font-mono">{fmt(c.rsi, 1)}</td>
                <td className="text-right font-mono">{fmt(Math.abs(c.slope || 0), 5)}</td>
                <td className="text-right font-mono">{fmt(c.scores?.combined ?? c.score, 5)}</td>
                <td className="text-rose-400 text-xs">{c.skipped || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
