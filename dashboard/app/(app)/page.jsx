'use client';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiGet } from '../../lib/api.js';
import StatCard from '../../components/StatCard.jsx';
import GridSymbolCard from '../../components/GridSymbolCard.jsx';

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');
const fmtUsd = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');

export default function DashboardPage() {
  const status = useQuery({ queryKey: ['status'], queryFn: () => apiGet('/status'), refetchInterval: 3000 });
  const grid = useQuery({ queryKey: ['grid-state'], queryFn: () => apiGet('/grid/state'), refetchInterval: 2000 });
  const balance = useQuery({
    queryKey: ['balance-history', 200],
    queryFn: () => apiGet('/balance/history', { limit: 200 }),
    refetchInterval: 5000,
  });

  const last = balance.data?.[balance.data.length - 1];
  const first = balance.data?.[0];
  const pnl = last && first ? last.equity - first.equity : 0;
  const pnlPct = last && first && first.equity ? (pnl / first.equity) * 100 : 0;

  const symbols = grid.data?.symbols || [];
  const totals = symbols.reduce(
    (a, s) => {
      a.positions += s.totalOpenPositions || 0;
      if (s.state === 'GRID') a.grid += 1;
      else if (s.state === 'HEDGE') a.hedge += 1;
      else if (s.state === 'RESET') a.reset += 1;
      if (s.hedgeActive) a.hedges += 1;
      return a;
    },
    { positions: 0, grid: 0, hedge: 0, reset: 0, hedges: 0 },
  );

  const chartData = (balance.data || []).map((b) => ({
    t: new Date(b.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    equity: b.equity,
    balance: b.balance,
  }));

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-100">Grid + Hedge Console</h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
            Per-symbol state machine. No indicators — pure price structure.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`chip ${status.data?.mode === 'live' ? 'chip-rose' : 'chip-sky'}`}>
            {status.data?.mode?.toUpperCase() || '—'}
          </span>
          <span className="chip chip-slate">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {symbols.length} symbol{symbols.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="Equity" value={fmtUsd(last?.equity)} sub={`Balance ${fmtUsd(last?.balance)}`} color="sky" />
        <StatCard
          label="Session PnL"
          value={`${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`}
          sub={`${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct)}%`}
          color={pnl >= 0 ? 'emerald' : 'rose'}
        />
        <StatCard
          label="States"
          value={`${totals.grid}G · ${totals.hedge}H · ${totals.reset}R`}
          sub={`${totals.hedges} active hedge${totals.hedges === 1 ? '' : 's'}`}
          color="amber"
        />
        <StatCard
          label="Open Positions"
          value={totals.positions}
          sub={totals.positions === 0 ? 'awaiting fills' : 'across grids'}
          color={totals.positions === 0 ? 'slate' : 'emerald'}
        />
      </div>

      <div className="card card-pad">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title">Equity Curve</h2>
          <span className="text-[11px] text-slate-500">last {chartData.length} ticks</span>
        </div>
        <div className="h-48 sm:h-60 -mx-2">
          <ResponsiveContainer>
            <AreaChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gEquity" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gBalance" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={32} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} domain={['auto', 'auto']} width={56} />
              <Tooltip
                contentStyle={{ background: '#0a0f17', border: '1px solid #243049', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#94a3b8' }}
              />
              <Area type="monotone" dataKey="balance" stroke="#38bdf8" strokeWidth={1.5} fill="url(#gBalance)" />
              <Area type="monotone" dataKey="equity" stroke="#34d399" strokeWidth={2} fill="url(#gEquity)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {symbols.length === 0 ? (
        <div className="card card-pad text-center text-slate-500 text-sm">
          Waiting for the orchestrator to select the symbol universe…
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {symbols.map((s) => <GridSymbolCard key={s.symbol} snap={s} />)}
        </div>
      )}
    </div>
  );
}
