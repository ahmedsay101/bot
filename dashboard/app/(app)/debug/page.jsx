'use client';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api.js';

const fmt = (n, d = 4) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');

const STATUS_STYLE = {
  WAITING: 'bg-slate-700/40 text-slate-300',
  SIGNAL: 'bg-amber-500/20 text-amber-300',
  EXECUTED: 'bg-emerald-500/20 text-emerald-300',
  REJECTED: 'bg-rose-500/20 text-rose-300',
};

const REGIME_STYLE = {
  RANGE: 'text-emerald-400',
  TREND: 'text-amber-400',
  UNKNOWN: 'text-slate-500',
};

export default function DebugPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['debug-evaluations'],
    queryFn: () => apiGet('/debug/evaluations'),
    refetchInterval: 2000,
  });

  if (isLoading) return <div className="text-slate-400">Loading…</div>;
  const evals = data?.evaluations || [];

  // Group rejected reasons for the "Why no trade?" panel
  const rejectionCounts = evals.reduce((acc, e) => {
    if (e.status === 'WAITING' || e.status === 'REJECTED') {
      const key = e.rejectReason || e.reason || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
    }
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Debug Mode</h2>
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              data?.debug ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700/40 text-slate-400'
            }`}
          >
            verbose logs: {data?.debug ? 'ON' : 'OFF'}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-1">
          Toggle in Settings (<code className="font-mono">"debug": true</code>) to also stream
          per-tick decisions to bot logs.
        </p>
      </div>

      {Object.keys(rejectionCounts).length > 0 && (
        <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-300 mb-2">Why no trade?</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Object.entries(rejectionCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <div
                  key={reason}
                  className="bg-slate-900/60 border border-slate-800 rounded px-3 py-2"
                >
                  <div className="text-xs text-slate-500">{reason}</div>
                  <div className="text-lg font-mono">{count}</div>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4 overflow-x-auto">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">
          Per-symbol evaluations ({evals.length})
        </h2>
        {evals.length === 0 ? (
          <div className="text-slate-500 text-sm">
            No evaluations yet. Wait for the orchestrator loop to tick.
          </div>
        ) : (
          <table className="w-full text-sm min-w-[700px]">
            <thead className="text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left py-2">Symbol</th>
                <th className="text-left">Status</th>
                <th className="text-left">Regime</th>
                <th className="text-right">RSI</th>
                <th className="text-right">|Slope|</th>
                <th className="text-left">Signal</th>
                <th className="text-left">Side</th>
                <th className="text-left">Reason</th>
                <th className="text-left">Pos</th>
                <th className="text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {evals.map((e) => (
                <tr key={e.symbol} className="border-t border-slate-800">
                  <td className="py-2 font-mono">{e.symbol}</td>
                  <td>
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded ${
                        STATUS_STYLE[e.status] || 'bg-slate-700/40 text-slate-300'
                      }`}
                    >
                      {e.status}
                    </span>
                  </td>
                  <td className={REGIME_STYLE[e.regime] || 'text-slate-500'}>{e.regime}</td>
                  <td className="text-right font-mono">{fmt(e.rsi, 2)}</td>
                  <td className="text-right font-mono">{fmt(Math.abs(e.slope || 0), 6)}</td>
                  <td className="text-slate-300">{e.signal}</td>
                  <td
                    className={
                      e.side === 'LONG'
                        ? 'text-emerald-400'
                        : e.side === 'SHORT'
                        ? 'text-rose-400'
                        : 'text-slate-500'
                    }
                  >
                    {e.side || '—'}
                  </td>
                  <td className="text-xs text-slate-400">
                    {e.rejectReason || e.reason || '—'}
                  </td>
                  <td className="text-xs">
                    {e.hasPosition ? (
                      <span className="text-sky-400">YES</span>
                    ) : (
                      <span className="text-slate-600">no</span>
                    )}
                  </td>
                  <td className="text-right text-xs text-slate-500">
                    {new Date(e.ts).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
