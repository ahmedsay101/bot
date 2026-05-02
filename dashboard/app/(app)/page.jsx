'use client';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiGet } from '../../lib/api.js';
import StatCard from '../../components/StatCard.jsx';

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');
const fmtUsd = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');

export default function DashboardPage() {
  const status = useQuery({ queryKey: ['status'], queryFn: () => apiGet('/status'), refetchInterval: 3000 });
  const positions = useQuery({ queryKey: ['positions'], queryFn: () => apiGet('/positions'), refetchInterval: 3000 });
  const balance = useQuery({
    queryKey: ['balance-history', 200],
    queryFn: () => apiGet('/balance/history', { limit: 200 }),
    refetchInterval: 5000,
  });

  const last = balance.data?.[balance.data.length - 1];
  const first = balance.data?.[0];
  const pnl = last && first ? last.equity - first.equity : 0;
  const pnlPct = last && first && first.equity ? (pnl / first.equity) * 100 : 0;
  const open = positions.data?.length || 0;
  const totalUpnl = (positions.data || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  const chartData = (balance.data || []).map((b) => ({
    t: new Date(b.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    equity: b.equity,
    balance: b.balance,
  }));

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-100">Overview</h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-0.5">Live trading session metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`chip ${status.data?.mode === 'live' ? 'chip-rose' : 'chip-sky'}`}>
            {status.data?.mode?.toUpperCase() || '—'}
          </span>
          <span className="chip chip-slate">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            ACTIVE
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          label="Equity"
          value={fmtUsd(last?.equity)}
          sub={`Balance ${fmtUsd(last?.balance)}`}
          color="sky"
        />
        <StatCard
          label="Session PnL"
          value={`${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`}
          sub={`${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct)}% since session start`}
          color={pnl >= 0 ? 'emerald' : 'rose'}
        />
        <StatCard
          label="Unrealized PnL"
          value={`${totalUpnl >= 0 ? '+' : ''}${fmtUsd(totalUpnl)}`}
          sub={`${open} open position${open === 1 ? '' : 's'}`}
          color={totalUpnl >= 0 ? 'emerald' : 'rose'}
        />
        <StatCard
          label="Open Positions"
          value={open}
          sub={open === 0 ? 'Awaiting setups' : 'Live exposure'}
          color="amber"
        />
      </div>

      {/* Equity curve */}
      <div className="card card-pad">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title">Equity Curve</h2>
          <span className="text-[11px] text-slate-500">Last {chartData.length} ticks</span>
        </div>
        <div className="h-56 sm:h-72 -mx-2">
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

      {/* Open positions */}
      <div className="card">
        <div className="flex items-center justify-between p-4 sm:p-5 pb-3">
          <h2 className="card-title">Open Positions</h2>
          <span className="chip chip-slate">{open}</span>
        </div>

        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="data-table min-w-[820px]">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry</th>
                <th className="text-right">Mark</th>
                <th className="text-right">uPnL</th>
                <th className="text-right">SL</th>
                <th className="text-right">TP</th>
                <th className="text-right">Liq</th>
              </tr>
            </thead>
            <tbody>
              {(positions.data || []).map((p) => {
                const upnl = p.unrealizedPnl;
                const upnlPct = p.unrealizedPnlPct;
                const cls = upnl == null ? 'num-mut' : upnl >= 0 ? 'num-pos' : 'num-neg';
                return (
                  <tr key={p.symbol}>
                    <td className="font-mono font-semibold text-slate-100">{p.symbol}</td>
                    <td>
                      <span className={`chip ${p.side === 'LONG' ? 'chip-emerald' : 'chip-rose'}`}>
                        {p.side}
                      </span>
                    </td>
                    <td className="text-right font-mono">{fmt(p.size, 4)}</td>
                    <td className="text-right font-mono">{fmt(p.entryPrice, 4)}</td>
                    <td className="text-right font-mono text-sky-300">{fmt(p.markPrice, 4)}</td>
                    <td className={`text-right font-mono ${cls}`}>
                      {upnl == null
                        ? '—'
                        : `${upnl >= 0 ? '+' : ''}$${fmt(upnl)} (${upnlPct >= 0 ? '+' : ''}${fmt(upnlPct)}%)`}
                    </td>
                    <td className="text-right font-mono text-rose-300/90">{fmt(p.stopPrice, 4)}</td>
                    <td className="text-right font-mono text-emerald-300/90">{fmt(p.takeProfitPrice, 4)}</td>
                    <td className="text-right font-mono text-amber-300/90">{fmt(p.liquidationPrice, 4)}</td>
                  </tr>
                );
              })}
              {(positions.data || []).length === 0 && (
                <tr><td colSpan={9} className="py-8 text-center text-slate-500">No open positions</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden p-3 space-y-2">
          {(positions.data || []).map((p) => {
            const upnl = p.unrealizedPnl;
            const upnlPct = p.unrealizedPnlPct;
            const cls = upnl == null ? 'num-mut' : upnl >= 0 ? 'num-pos' : 'num-neg';
            return (
              <div key={p.symbol} className="border border-slate-800 rounded-lg p-3 bg-slate-900/30">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-slate-100">{p.symbol}</span>
                    <span className={`chip ${p.side === 'LONG' ? 'chip-emerald' : 'chip-rose'}`}>{p.side}</span>
                  </div>
                  <div className={`text-right font-mono text-sm ${cls}`}>
                    {upnl == null ? '—' : `${upnl >= 0 ? '+' : ''}$${fmt(upnl)}`}
                    {upnlPct != null && (
                      <div className="text-[10px] opacity-70">{upnlPct >= 0 ? '+' : ''}{fmt(upnlPct)}%</div>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div><div className="text-slate-500">Size</div><div className="font-mono">{fmt(p.size, 4)}</div></div>
                  <div><div className="text-slate-500">Entry</div><div className="font-mono">{fmt(p.entryPrice, 4)}</div></div>
                  <div><div className="text-slate-500">Mark</div><div className="font-mono text-sky-300">{fmt(p.markPrice, 4)}</div></div>
                  <div><div className="text-slate-500">SL</div><div className="font-mono text-rose-300/90">{fmt(p.stopPrice, 4)}</div></div>
                  <div><div className="text-slate-500">TP</div><div className="font-mono text-emerald-300/90">{fmt(p.takeProfitPrice, 4)}</div></div>
                  <div><div className="text-slate-500">Liq</div><div className="font-mono text-amber-300/90">{fmt(p.liquidationPrice, 4)}</div></div>
                </div>
              </div>
            );
          })}
          {(positions.data || []).length === 0 && (
            <div className="py-8 text-center text-slate-500 text-sm">No open positions</div>
          )}
        </div>
      </div>
    </div>
  );
}
