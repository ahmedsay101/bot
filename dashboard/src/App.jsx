import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "";

function fmt(v, d = 2) {
  if (v == null || Number.isNaN(v)) return "-";
  return Number(v).toFixed(d);
}

function fmtPrice(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function pnlColor(v) {
  return Number(v) >= 0 ? "text-emerald-400" : "text-rose-400";
}

function dirColor(dir) {
  return dir === "LONG" ? "text-emerald-400" : "text-rose-400";
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return "-";
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const hrs = (end - start) / 3_600_000;
  if (hrs < 0.1) return `${Math.round(hrs * 60)}m`;
  return `${hrs.toFixed(1)}h`;
}

/* ── Stat Card ─────────────────────────────────────────────── */
function StatCard({ label, value, sub, color }) {
  return (
    <div className="glass rounded-2xl p-5">
      <p className="text-[11px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color || "text-slate-100"}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/* ── Accumulated SL Progress Bar ────────────────────────────── */
/* (removed — not used in hedge strategy) */

/* ── Dual-Position Price Indicator ──────────────────────────── */
function DualPriceIndicator({ trader }) {
  const price = Number(trader.lastPrice);
  const longTp = Number(trader.longTp);
  const longSl = Number(trader.longSl);
  const longEntry = Number(trader.longEntry);
  const shortTp = Number(trader.shortTp);
  const shortSl = Number(trader.shortSl);
  const shortEntry = Number(trader.shortEntry);
  if (!Number.isFinite(price)) return null;

  const all = [longTp, longSl, longEntry, shortTp, shortSl, shortEntry, price].filter(Number.isFinite);
  if (all.length === 0) return null;
  const low = Math.min(...all) * 0.97;
  const high = Math.max(...all) * 1.03;
  const range = high - low || 1;
  const pct = (v) => Math.max(0, Math.min(100, ((v - low) / range) * 100));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>SL {fmtPrice(longSl)}</span>
        <span>Entry {fmtPrice(longEntry)}</span>
        <span>Price {fmtPrice(price)}</span>
        <span>Entry {fmtPrice(shortEntry)}</span>
        <span>SL {fmtPrice(shortSl)}</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-800">
        {/* LONG SL zone (left) */}
        <div className="absolute h-full bg-rose-500/10" style={{ left: 0, width: `${pct(longSl)}%` }} />
        {/* SHORT SL zone (right) */}
        <div className="absolute h-full bg-rose-500/10" style={{ left: `${pct(shortSl)}%`, width: `${100 - pct(shortSl)}%` }} />
        {/* LONG TP line */}
        <div className="absolute top-0 h-full w-0.5 bg-emerald-400/80" style={{ left: `${pct(longTp)}%` }} title={`LONG TP ${fmtPrice(longTp)}`} />
        {/* SHORT TP line */}
        <div className="absolute top-0 h-full w-0.5 bg-emerald-400/80" style={{ left: `${pct(shortTp)}%` }} title={`SHORT TP ${fmtPrice(shortTp)}`} />
        {/* LONG SL line */}
        <div className="absolute top-0 h-full w-0.5 bg-rose-400/80" style={{ left: `${pct(longSl)}%` }} title={`LONG SL ${fmtPrice(longSl)}`} />
        {/* SHORT SL line */}
        <div className="absolute top-0 h-full w-0.5 bg-rose-400/80" style={{ left: `${pct(shortSl)}%` }} title={`SHORT SL ${fmtPrice(shortSl)}`} />
        {/* LONG entry */}
        <div className="absolute top-0 h-full w-0.5 bg-amber-400/60" style={{ left: `${pct(longEntry)}%` }} title={`LONG Entry`} />
        {/* SHORT entry */}
        <div className="absolute top-0 h-full w-0.5 bg-amber-400/60" style={{ left: `${pct(shortEntry)}%` }} title={`SHORT Entry`} />
        {/* Current price marker */}
        <div
          className="absolute top-0 h-full w-1.5 rounded-full bg-sky-400 shadow-lg shadow-sky-400/50 transition-all"
          style={{ left: `calc(${pct(price)}% - 3px)` }}
        />
      </div>
    </div>
  );
}

/* ── Trade History Table ───────────────────────────────────── */
function TradeTable({ trades }) {
  if (!trades || trades.length === 0) return (
    <p className="py-3 text-center text-xs text-slate-600">No trades yet</p>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/5 text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-2 pr-3">#</th>
            <th className="py-2 pr-3">Dir</th>
            <th className="py-2 pr-3">Reason</th>
            <th className="py-2 pr-3 text-right">Entry</th>
            <th className="py-2 pr-3 text-right">Exit</th>
            <th className="py-2 pr-3 text-right">Qty</th>
            <th className="py-2 pr-3 text-right">Gross</th>
            <th className="py-2 pr-3 text-right">Fees</th>
            <th className="py-2 text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice().reverse().map((t, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-1.5 pr-3 text-slate-500">{trades.length - i}</td>
              <td className="py-1.5 pr-3">
                <span className={dirColor(t.direction)}>{t.direction}</span>
              </td>
              <td className="py-1.5 pr-3 text-slate-400">{t.reason}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-300">{fmtPrice(t.entry)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-300">{fmtPrice(t.exit)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-400">{fmt(t.quantity, 4)}</td>
              <td className={`py-1.5 pr-3 text-right font-mono font-bold ${pnlColor(t.grossPnl)}`}>
                {fmt(t.grossPnl, 4)}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-500">{fmt(t.fees, 4)}</td>
              <td className={`py-1.5 text-right font-mono font-bold ${pnlColor(t.netPnl)}`}>
                {fmt(t.netPnl, 4)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Trader Card ───────────────────────────────────────────── */
function TraderCard({ trader, onDestroy }) {
  const [expanded, setExpanded] = useState(false);
  const netPnl = (trader.realizedPnl || 0) + (trader.unrealizedPnl || 0);

  return (
    <div className="glass rounded-2xl overflow-hidden">
      <button
        type="button"
        className="w-full p-5 text-left hover:bg-white/[0.02] transition"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-bold text-slate-100">{trader.symbol}</h3>
            <span className="rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
              HEDGE {trader.leverage || 2}x
            </span>
            {/* Leg status badges */}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${
              trader.longActive
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
                : "bg-slate-700/50 text-slate-500 border-slate-600/20"
            }`}>
              LONG {trader.longActive ? "●" : "✓"}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${
              trader.shortActive
                ? "bg-rose-500/15 text-rose-400 border-rose-500/20"
                : "bg-slate-700/50 text-slate-500 border-slate-600/20"
            }`}>
              SHORT {trader.shortActive ? "●" : "✓"}
            </span>
            <span className="text-[10px] text-slate-500">
              {trader.createdAt ? new Date(trader.createdAt).toLocaleString() : ""}
              {trader.createdAt ? ` · ${fmtDuration(trader.createdAt)}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className={`rounded-full bg-white/5 border border-white/10 px-2.5 py-1 ${pnlColor(netPnl)}`}>
                Net ${fmt(netPnl)}
              </span>
            </div>
            <button
              type="button"
              className="ml-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/25"
              onClick={(e) => {
                e.stopPropagation();
                if (!window.confirm(`Destroy trader for ${trader.symbol}?`)) return;
                onDestroy(trader.symbol);
              }}
            >
              Destroy
            </button>
          </div>
        </div>

        {/* Dual-position price pills */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="text-[10px] uppercase text-slate-500 self-center mr-1">Long</span>
            <span className="rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-slate-300">
              {fmtPrice(trader.longEntry)}
            </span>
            <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-emerald-400">
              TP {fmtPrice(trader.longTp)}
            </span>
            <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-rose-400">
              SL {fmtPrice(trader.longSl)}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="text-[10px] uppercase text-slate-500 self-center mr-1">Short</span>
            <span className="rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-slate-300">
              {fmtPrice(trader.shortEntry)}
            </span>
            <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-emerald-400">
              TP {fmtPrice(trader.shortTp)}
            </span>
            <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-rose-400">
              SL {fmtPrice(trader.shortSl)}
            </span>
          </div>
        </div>

        <div className="mt-2">
          <DualPriceIndicator trader={trader} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-5 space-y-5">
          {/* Config Info */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-sm">
            <div>
              <p className="text-[10px] uppercase text-slate-500">Start Price</p>
              <p className="font-mono text-slate-200">{fmtPrice(trader.startPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Current Price</p>
              <p className="font-mono text-slate-200">{fmtPrice(trader.lastPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Long Entry</p>
              <p className="font-mono text-emerald-400">{fmtPrice(trader.longEntry)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Short Entry</p>
              <p className="font-mono text-rose-400">{fmtPrice(trader.shortEntry)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Quantity</p>
              <p className="font-mono text-slate-200">{fmt(trader.quantity, 4)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Notional</p>
              <p className="font-mono text-slate-200">${fmt(trader.notional)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Margin</p>
              <p className="font-mono text-slate-200">${fmt(trader.margin)}</p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Unrealized</p>
              <p className={`text-sm font-mono font-bold ${pnlColor(trader.unrealizedPnl)}`}>
                ${fmt(trader.unrealizedPnl, 4)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Realized</p>
              <p className={`text-sm font-mono font-bold ${pnlColor(trader.realizedPnl)}`}>
                ${fmt(trader.realizedPnl, 4)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Fees Paid</p>
              <p className="text-sm font-mono text-slate-400">${fmt(trader.feesPaid, 4)}</p>
            </div>
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Duration</p>
              <p className="text-sm font-mono text-slate-300">{fmtDuration(trader.createdAt)}</p>
            </div>
          </div>

          {/* Trade History */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
              Trade History ({trader.totalTrades || trader.tradeHistory?.length || 0})
            </h4>
            <TradeTable trades={trader.tradeHistory} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Trader History Table ──────────────────────────────────── */
function TraderHistoryTable({ history }) {
  if (!history || history.length === 0) return (
    <p className="py-3 text-center text-xs text-slate-600">No closed traders yet</p>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/5 text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-2 pr-3">Symbol</th>
            <th className="py-2 pr-3">Trades</th>
            <th className="py-2 pr-3 text-right">PnL</th>
            <th className="py-2 pr-3 text-right">Fees</th>
            <th className="py-2 pr-3">Reason</th>
            <th className="py-2 pr-3">Duration</th>
            <th className="py-2">Closed</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h, i) => (
            <tr key={h.id || i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-1.5 pr-3 font-medium text-slate-200">{h.symbol}</td>
              <td className="py-1.5 pr-3 font-mono text-slate-400">{h.totalTrades || 0}</td>
              <td className={`py-1.5 pr-3 text-right font-mono font-bold ${pnlColor(h.realizedPnl)}`}>
                ${fmt(h.realizedPnl, 4)}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-500">${fmt(h.feesPaid, 4)}</td>
              <td className="py-1.5 pr-3">
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                  h.reason === "take-profit"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : h.reason === "max-loss"
                    ? "bg-rose-500/15 text-rose-400"
                    : "bg-slate-700/50 text-slate-400"
                }`}>
                  {h.reason}
                </span>
              </td>
              <td className="py-1.5 pr-3 font-mono text-slate-400">
                {fmtDuration(h.createdAt, h.closedAt)}
              </td>
              <td className="py-1.5 text-slate-500">
                {h.closedAt ? new Date(h.closedAt).toLocaleTimeString() : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Top Gainers Table ─────────────────────────────────────── */
function TopGainersTable({ gainers, activeSymbols }) {
  if (!gainers || gainers.length === 0) return (
    <p className="text-xs text-slate-600">No data</p>
  );

  return (
    <div className="space-y-2">
      {gainers.map((g) => {
        const hasTrader = activeSymbols.has(g.symbol);
        return (
          <div key={g.symbol} className="flex items-center justify-between rounded-xl bg-slate-800/40 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">{g.symbol}</span>
              {hasTrader && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-400">
                  ACTIVE
                </span>
              )}
            </div>
            <span className="text-sm font-bold text-emerald-400">+{fmt(g.percent)}%</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── App ───────────────────────────────────────────────────── */
function App() {
  const [status, setStatus] = useState({
    mode: "TEST", balance: 0, equity: 0, pnlToday: 0,
    activeTraders: 0, maxTraders: 0
  });
  const [traders, setTraders] = useState([]);
  const [performance, setPerformance] = useState({
    totalTrades: 0, winRate: 0, wins: 0, losses: 0,
    grossProfit: 0, grossLoss: 0,
    netProfit: 0, feesPaid: 0, maxDrawdown: 0, unrealizedPnl: 0
  });
  const [socketStatus, setSocketStatus] = useState("disconnected");
  const [topGainers, setTopGainers] = useState([]);
  const [closedTraders, setClosedTraders] = useState([]);

  const activeSymbols = useMemo(
    () => new Set(traders.map((t) => t.symbol)),
    [traders]
  );

  useEffect(() => {
    Promise.all([
      axios.get(`${API_URL}/api/status`),
      axios.get(`${API_URL}/api/traders`),
      axios.get(`${API_URL}/api/performance`)
    ]).then(([sRes, tRes, pRes]) => {
      setStatus(sRes.data);
      setTraders(tRes.data);
      setPerformance((p) => ({ ...p, ...(pRes.data || {}) }));
    }).catch(() => setSocketStatus("error"));
  }, []);

  useEffect(() => {
    const socket = io(API_URL, { path: "/api/socket.io", transports: ["websocket"] });
    socket.on("connect", () => setSocketStatus("connected"));
    socket.on("disconnect", () => setSocketStatus("disconnected"));

    socket.on("dashboardUpdate", (d) => {
      const next = d.traders || [];
      const bal = Number(d.balance || 0);
      const unr = next.reduce((s, t) => s + Number(t.unrealizedPnl || 0), 0);
      setTraders((prev) => {
        const priceMap = new Map(prev.map((t) => [t.symbol, t.lastPrice]));
        return next.map((t) => {
          const cached = priceMap.get(t.symbol);
          if (cached != null && Number.isFinite(cached) && cached > t.lastPrice) {
            return { ...t, lastPrice: cached };
          }
          return t;
        });
      });

      setPerformance((p) => ({ ...p, ...(d.performance || {}) }));
      if (d.topGainers) setTopGainers(d.topGainers);
      if (d.closedTraders) setClosedTraders(d.closedTraders);
      setStatus((p) => ({ ...p, ...(d.status || {}), balance: bal, equity: bal + unr }));
    });

    socket.on("priceUpdate", ({ symbol, price }) => {
      if (!symbol || !Number.isFinite(Number(price))) return;
      setTraders((prev) =>
        prev.map((t) => (t.symbol === symbol ? { ...t, lastPrice: Number(price) } : t))
      );
    });

    return () => socket.disconnect();
  }, []);

  function handleDestroy(symbol) {
    axios.delete(`${API_URL}/api/traders/${symbol}`).catch(() => {});
  }

  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">

        {/* ── Header ── */}
        <div className="glass rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Hedge Trader</h1>
            <p className="text-xs text-slate-500 mt-1">
              Binance Futures · {status.mode}
              <span className="ml-3">{socketStatus === "connected" ? "● Connected" : "○ Disconnected"}</span>
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-slate-300">
              Equity ${fmt(status.equity)}
            </span>
            <span className="rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-slate-300">
              Traders {traders.length}/{status.maxTraders}
            </span>
          </div>
        </div>

        {/* ── Main Stats Row ── */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Balance" value={`$${fmt(status.balance)}`} />
          <StatCard label="Equity" value={`$${fmt(status.equity)}`} />
          <StatCard
            label="Net Profit"
            value={`$${fmt(performance.netProfit)}`}
            color={pnlColor(performance.netProfit)}
          />
          <StatCard label="Trades" value={performance.totalTrades} sub={`${fmt(performance.winRate)}% win rate`} />
          <StatCard label="Fees" value={`$${fmt(performance.feesPaid)}`} color="text-slate-400" />
        </div>

        {/* ── Top Gainers + Traders ── */}
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          {/* Traders list */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Active Traders</h2>
            {traders.length === 0 && (
              <div className="glass rounded-2xl p-8 text-center text-slate-500">
                No active traders. Waiting for scanner to find candidates...
              </div>
            )}
            {traders.map((t) => (
              <TraderCard key={t.id} trader={t} onDestroy={handleDestroy} />
            ))}
          </div>

          {/* Top Gainers */}
          <div>
            <h2 className="text-lg font-semibold mb-4">Top Gainers (24h)</h2>
            <div className="glass rounded-2xl p-4">
              <TopGainersTable gainers={topGainers} activeSymbols={activeSymbols} />
            </div>
          </div>
        </div>

        {/* ── Trader History ── */}
        <div>
          <h2 className="text-lg font-semibold mb-4">Trader History ({closedTraders.length})</h2>
          <div className="glass rounded-2xl p-5">
            <TraderHistoryTable history={closedTraders} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
