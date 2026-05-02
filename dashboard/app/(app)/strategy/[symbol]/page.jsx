'use client';
import { useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { apiGet } from '../../../../lib/api.js';

const fmt = (n, d = 4) => (typeof n === 'number' ? n.toFixed(d) : '—');

export default function StrategyMonitorPage({ params }) {
  const { symbol } = use(params);
  const router = useRouter();
  const [input, setInput] = useState(symbol || '');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['strategy', symbol],
    queryFn: () => apiGet(`/strategy/${symbol}`),
    enabled: !!symbol,
    refetchInterval: 5000,
  });

  const submit = (e) => {
    e.preventDefault();
    if (input) router.push(`/strategy/${input.toUpperCase()}`);
  };

  const candles = data?.candles || [];
  const rsiArr = data?.indicators?.rsi || [];
  const atrArr = data?.indicators?.atr || [];
  const maArr = data?.indicators?.ma || [];
  const regimeName = typeof data?.regime === 'string' ? data.regime : data?.regime?.regime;

  const chartData = candles.map((c, i) => ({
    t: new Date(c.closeTime).toLocaleTimeString(),
    close: c.close,
    ma: maArr[i],
    rsi: rsiArr[i],
    atr: atrArr[i],
  }));

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Symbol</label>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="BTCUSDT"
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <button className="bg-sky-600 hover:bg-sky-500 text-sm font-semibold rounded px-3 py-1.5">Load</button>
        {data && (
          <div className="ml-auto text-sm">
            Regime:{' '}
            <span
              className={
                regimeName === 'RANGE'
                  ? 'text-emerald-400'
                  : regimeName === 'TREND'
                  ? 'text-amber-400'
                  : 'text-slate-500'
              }
            >
              {regimeName || '—'}
            </span>{' '}
            <span className="text-slate-500">
              | ATR {fmt(atrArr[atrArr.length - 1])} | RSI {fmt(rsiArr[rsiArr.length - 1], 1)}
            </span>
          </div>
        )}
      </form>

      {isLoading && <div className="text-slate-400">Loading…</div>}
      {isError && <div className="text-rose-400">Failed to load.</div>}

      {data && (
        <>
          <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-slate-300 mb-2">Price + MA</h2>
            <div className="h-64">
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ background: '#0a0e14', border: '1px solid #334155' }} />
                  <Line type="monotone" dataKey="close" stroke="#38bdf8" dot={false} strokeWidth={1.5} />
                  <Line type="monotone" dataKey="ma" stroke="#f59e0b" dot={false} strokeWidth={1} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-[#0a0e14] border border-slate-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-slate-300 mb-2">RSI</h2>
            <div className="h-40">
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: '#0a0e14', border: '1px solid #334155' }} />
                  <ReferenceLine y={70} stroke="#f43f5e" strokeDasharray="3 3" />
                  <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="rsi" stroke="#a78bfa" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
