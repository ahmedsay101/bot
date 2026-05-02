'use client';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiGet } from '../../lib/api.js';
import StatCard from '../../components/StatCard.jsx';

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');

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
  const open = positions.data?.length || 0;

  const chartData = (balance.data || []).map((b) => ({
    t: new Date(b.ts).toLocaleTimeString(),
    equity: b.equity,
    balance: b.balance,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Mode" value={status.data?.mode?.toUpperCase() || '—'} color="sky" />
        <StatCard
          label="Equity"
          value={`$${fmt(last?.equity)}`}
          sub={`Balance $${fmt(last?.balance)}`}
          color="emerald"
        />
        <StatCard
          label="Session PnL"
          value={`${pnl >= 0 ? '+' : ''}$${fmt(pnl)}`}
          color={pnl >= 0 ? 'emerald' : 'rose'}
        />
        <StatCard label="Open Positions" value={open} color="amber" />
      </div>

      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Equity Curve</h2>
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} />
              <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0a0e14', border: '1px solid #334155' }} />
              <Line type="monotone" dataKey="equity" stroke="#34d399" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="balance" stroke="#38bdf8" dot={false} strokeWidth={1} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Open Positions</h2>
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left py-2">Symbol</th>
              <th className="text-left">Side</th>
              <th className="text-right">Size</th>
              <th className="text-right">Entry</th>
              <th className="text-right">SL</th>
              <th className="text-right">TP</th>
              <th className="text-right">Liq</th>
            </tr>
          </thead>
          <tbody>
            {(positions.data || []).map((p) => (
              <tr key={p.symbol} className="border-t border-slate-800">
                <td className="py-2 font-mono">{p.symbol}</td>
                <td className={p.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}>{p.side}</td>
                <td className="text-right font-mono">{fmt(p.size, 4)}</td>
                <td className="text-right font-mono">{fmt(p.entryPrice, 4)}</td>
                <td className="text-right font-mono text-rose-300">{fmt(p.stopPrice, 4)}</td>
                <td className="text-right font-mono text-emerald-300">{fmt(p.takeProfitPrice, 4)}</td>
                <td className="text-right font-mono text-amber-300">{fmt(p.liquidationPrice, 4)}</td>
              </tr>
            ))}
            {(positions.data || []).length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-center text-slate-500">
                  No open positions
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
