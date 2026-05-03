'use client';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../lib/api.js';
import GridSymbolCard from '../../../components/GridSymbolCard.jsx';

const fmt = (n, d = 4) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');
const fmtMs = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

export default function DebugPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['debug-evaluations'],
    queryFn: () => apiGet('/debug/evaluations'),
    refetchInterval: 2000,
  });

  if (isLoading || !data) {
    return <div className="text-slate-400 text-sm">Loading orchestrator state…</div>;
  }

  const symbols = data.symbols || [];
  const orch = data.orchestrator || {};

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-100">Engine Debug</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Per-symbol grid + hedge state machine snapshots.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <span className="chip chip-slate">universe {orch.universeSize ?? symbols.length}</span>
          <span className="chip chip-slate">refresh in {fmtMs(orch.nextRefreshInMs)}</span>
          <span className="chip chip-slate">loop {orch.loopIntervalMs ?? '—'}ms</span>
          {orch.killSwitch && <span className="chip chip-rose">KILL SWITCH</span>}
        </div>
      </div>

      {symbols.length === 0 ? (
        <div className="card card-pad text-center text-slate-500 text-sm">
          No symbol engines active yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {symbols.map((s) => (
            <div key={s.symbol} className="space-y-2">
              <GridSymbolCard snap={s} />
              <details className="card card-pad text-[11px] font-mono text-slate-400">
                <summary className="cursor-pointer text-slate-500">raw snapshot</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre">{JSON.stringify(s, null, 2)}</pre>
                <div className="mt-2 text-slate-500">
                  range built: {fmt(s.rangeBuiltAt ? (Date.now() - s.rangeBuiltAt) : NaN, 0)} ms ago
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
