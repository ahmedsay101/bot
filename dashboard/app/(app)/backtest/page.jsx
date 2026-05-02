'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiGet, apiPost } from '../../../lib/api.js';

const fmt = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '—');

function Metric({ label, value, positive }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded p-3">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-lg font-semibold ${positive === undefined ? 'text-slate-200' : positive ? 'text-emerald-400' : 'text-rose-400'}`}>
        {value}
      </div>
    </div>
  );
}

export default function BacktestPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    symbol: 'BTCUSDT',
    interval: '1m',
    fromTs: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 16),
    toTs: new Date().toISOString().slice(0, 16),
    startingBalance: 600,
  });
  const [selectedId, setSelectedId] = useState(null);

  const list = useQuery({
    queryKey: ['backtest-list'],
    queryFn: () => apiGet('/backtest'),
    refetchInterval: 5000,
  });

  const detail = useQuery({
    queryKey: ['backtest', selectedId],
    queryFn: () => apiGet(`/backtest/${selectedId}`),
    enabled: !!selectedId,
    refetchInterval: (q) => (q.state.data?.status === 'running' || q.state.data?.status === 'queued' ? 2000 : false),
  });

  const create = useMutation({
    mutationFn: (body) => apiPost('/backtest', body),
    onSuccess: (data) => {
      setSelectedId(data._id || data.id);
      qc.invalidateQueries({ queryKey: ['backtest-list'] });
    },
  });

  const submit = (e) => {
    e.preventDefault();
    create.mutate({
      symbol: form.symbol,
      interval: form.interval,
      fromTs: new Date(form.fromTs).getTime(),
      toTs: new Date(form.toTs).getTime(),
      startingBalance: Number(form.startingBalance),
    });
  };

  const equity = (detail.data?.equityCurve || []).map((e) => ({
    t: new Date(e.ts).toLocaleDateString(),
    equity: e.equity,
  }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <form onSubmit={submit} className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4 space-y-3">
        <h2 className="font-semibold">New Backtest</h2>
        {['symbol', 'interval'].map((k) => (
          <div key={k}>
            <label className="block text-xs text-slate-400 mb-1">{k}</label>
            <input
              value={form[k]}
              onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
            />
          </div>
        ))}
        <div>
          <label className="block text-xs text-slate-400 mb-1">From</label>
          <input
            type="datetime-local"
            value={form.fromTs}
            onChange={(e) => setForm((f) => ({ ...f, fromTs: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">To</label>
          <input
            type="datetime-local"
            value={form.toTs}
            onChange={(e) => setForm((f) => ({ ...f, toTs: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Starting Balance ($)</label>
          <input
            type="number"
            value={form.startingBalance}
            onChange={(e) => setForm((f) => ({ ...f, startingBalance: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <button
          disabled={create.isPending}
          className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded py-2 text-sm font-semibold"
        >
          {create.isPending ? 'Queueing…' : 'Run Backtest'}
        </button>
      </form>

      <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
        <h2 className="font-semibold mb-2">Recent</h2>
        <ul className="space-y-1 text-sm">
          {(list.data || []).map((b) => (
            <li key={b._id}>
              <button
                onClick={() => setSelectedId(b._id)}
                className={`w-full text-left px-2 py-1.5 rounded font-mono ${
                  selectedId === b._id ? 'bg-sky-500/20 text-sky-300' : 'hover:bg-slate-800/50'
                }`}
              >
                <span className="text-slate-300">{b.symbol}</span>{' '}
                <span className="text-xs text-slate-500">{b.interval}</span>
                <span className="ml-2 text-xs">{b.status}</span>
              </button>
            </li>
          ))}
          {(list.data || []).length === 0 && <li className="text-slate-500 text-xs">No backtests yet.</li>}
        </ul>
      </div>

      <div className="lg:col-span-3 bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
        {!selectedId && <div className="text-slate-500">Select or run a backtest.</div>}
        {selectedId && detail.data && (
          <>
            <div className="flex items-center gap-4 mb-3">
              <h2 className="font-semibold font-mono">{detail.data.symbol}</h2>
              <span className="text-xs text-slate-400">{detail.data.status}</span>
              {detail.data.status !== 'done' && (
                <span className="text-xs text-slate-500">{(detail.data.progress * 100).toFixed(1)}%</span>
              )}
              {detail.data.error && <span className="text-rose-400 text-xs">{detail.data.error}</span>}
            </div>
            {detail.data.metrics && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-sm">
                <Metric label="Net PnL" value={`$${fmt(detail.data.metrics.netPnl)}`} positive={detail.data.metrics.netPnl >= 0} />
                <Metric label="Trades" value={detail.data.metrics.trades} />
                <Metric label="Win Rate" value={`${(detail.data.metrics.winRate * 100).toFixed(1)}%`} />
                <Metric label="Max DD" value={`${(detail.data.metrics.maxDrawdown * 100).toFixed(1)}%`} />
                <Metric label="Sharpe" value={fmt(detail.data.metrics.sharpe, 2)} />
              </div>
            )}
            <div className="h-64">
              <ResponsiveContainer>
                <LineChart data={equity}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ background: '#0a0e14', border: '1px solid #334155' }} />
                  <Line type="monotone" dataKey="equity" stroke="#34d399" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
