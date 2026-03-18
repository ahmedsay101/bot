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

/* ── Trap Level Indicator ──────────────────────────────────── */
function TrapLevelIndicator({ trader }) {
  const price = Number(trader.lastPrice);
  const start = Number(trader.startPrice);
  const longEntry = Number(trader.longEntryPrice);
  const shortEntry = Number(trader.shortEntryPrice);
  if (!Number.isFinite(price) || !Number.isFinite(start)) return null;

  const range = longEntry - shortEntry;
  const pricePct = range > 0 ? ((price - shortEntry) / range) * 100 : 50;
  const clampedPct = Math.max(0, Math.min(100, pricePct));

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>SHORT {fmtPrice(shortEntry)}</span>
        <span>SL {fmtPrice(start)}</span>
        <span>LONG {fmtPrice(longEntry)}</span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-800">
        {/* Short zone */}
        <div className="absolute left-0 h-full w-1/2 bg-rose-500/15" />
        {/* Long zone */}
        <div className="absolute right-0 h-full w-1/2 bg-emerald-500/15" />
        {/* Center line (SL) */}
        <div className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-amber-400/60" />
        {/* Price marker */}
        <div
          className="absolute top-0 h-full w-1.5 rounded-full bg-sky-400 shadow-lg shadow-sky-400/50 transition-all"
          style={{ left: `calc(${clampedPct}% - 3px)` }}
        />
      </div>
    </div>
  );
}

/* ── Open Position Row ─────────────────────────────────────── */
function PositionRow({ pos }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-slate-800/40 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase ${
          pos.direction === "LONG"
            ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
            : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
        }`}>
          {pos.direction}
        </span>
        <span className="text-xs font-mono text-slate-300">@ {fmtPrice(pos.entryPrice)}</span>
        <span className="text-[10px] text-slate-500">qty {fmt(pos.quantity, 4)}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-slate-500">SL {fmtPrice(pos.stopLossPrice)}</span>
        <span className={`text-xs font-mono font-bold ${pnlColor(pos.unrealizedPnl)}`}>
          ${fmt(pos.unrealizedPnl, 4)}
        </span>
      </div>
    </div>
  );
}

/* ── Pending Entry Row ─────────────────────────────────────── */
function PendingEntryRow({ entry }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-slate-800/20 border border-dashed border-white/10 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${
          entry.direction === "LONG"
            ? "bg-emerald-500/10 text-emerald-500/70 border border-emerald-500/20"
            : "bg-rose-500/10 text-rose-500/70 border border-rose-500/20"
        }`}>
          {entry.direction}
        </span>
        <span className="text-xs text-slate-500">pending</span>
      </div>
      <span className="text-xs font-mono text-slate-400">@ {fmtPrice(entry.price)}</span>
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
                <span className={t.direction === "LONG" ? "text-emerald-400" : "text-rose-400"}>
                  {t.direction}
                </span>
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
  const openPositions = trader.openPositions || [];
  const pendingEntries = trader.pendingEntries || [];
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
            <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 border border-amber-500/20">
              TRAP ±{trader.trapPercent || 1}%
            </span>
            {openPositions.map((p, i) => (
              <span key={i} className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${
                p.direction === "LONG"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-rose-500/15 text-rose-400"
              }`}>
                {p.direction}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-slate-300">
                {trader.totalTrades || 0} trades · {trader.slCount || 0} SL
              </span>
              <span className={`rounded-full bg-white/5 border border-white/10 px-2.5 py-1 ${pnlColor(netPnl)}`}>
                Net ${fmt(netPnl)}
              </span>
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-sky-400">
                Peak ${fmt(trader.highestNetProfit)}
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

        <div className="mt-3">
          <TrapLevelIndicator trader={trader} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-5 space-y-5">
          {/* Trap Info */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-[10px] uppercase text-slate-500">Start Price</p>
              <p className="font-mono text-slate-200">{fmtPrice(trader.startPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Current Price</p>
              <p className="font-mono text-slate-200">{fmtPrice(trader.lastPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">LONG Entry</p>
              <p className="font-mono text-emerald-400">{fmtPrice(trader.longEntryPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">SHORT Entry</p>
              <p className="font-mono text-rose-400">{fmtPrice(trader.shortEntryPrice)}</p>
            </div>
          </div>

          {/* Open Positions */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
              Open Positions ({openPositions.length})
            </h4>
            {openPositions.length === 0 ? (
              <p className="text-xs text-slate-600">No open positions</p>
            ) : (
              <div className="space-y-1.5">
                {openPositions.map((p, i) => <PositionRow key={i} pos={p} />)}
              </div>
            )}
          </div>

          {/* Pending Entries */}
          {pendingEntries.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                Pending Entries ({pendingEntries.length})
              </h4>
              <div className="space-y-1.5">
                {pendingEntries.map((e, i) => <PendingEntryRow key={i} entry={e} />)}
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Realized</p>
              <p className={`text-sm font-mono font-bold ${pnlColor(trader.realizedPnl)}`}>
                ${fmt(trader.realizedPnl, 4)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Unrealized</p>
              <p className={`text-sm font-mono font-bold ${pnlColor(trader.unrealizedPnl)}`}>
                ${fmt(trader.unrealizedPnl, 4)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Fees Paid</p>
              <p className="text-sm font-mono text-slate-400">${fmt(trader.feesPaid, 4)}</p>
            </div>
            <div className="rounded-xl bg-slate-800/40 p-3">
              <p className="text-[10px] uppercase text-slate-500">Peak Profit</p>
              <p className="text-sm font-mono font-bold text-sky-400">${fmt(trader.highestNetProfit, 4)}</p>
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
/* ── Win/Loss Streak ───────────────────────────────────── */
function WinLossStreak({ results }) {
  if (!results || results.length === 0) return null;
  const wins = results.filter(r => r.result === "win").length;
  const losses = results.filter(r => r.result === "loss").length;

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Trader Results</h3>
        <div className="flex gap-3 text-xs">
          <span className="text-emerald-400">{wins}W</span>
          <span className="text-rose-400">{losses}L</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {results.map((r, i) => (
          <div
            key={i}
            title={`${r.symbol} — ${r.result} — $${fmt(r.pnl)}`}
            className={`w-4 h-4 rounded-full border ${
              r.result === "win"
                ? "bg-emerald-500 border-emerald-400 shadow-sm shadow-emerald-500/40"
                : "bg-rose-500 border-rose-400 shadow-sm shadow-rose-500/40"
            }`}
          />
        ))}
      </div>
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
  const [traderResults, setTraderResults] = useState([]);

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
      setTraders(next);
      setPerformance((p) => ({ ...p, ...(d.performance || {}) }));
      if (d.topGainers) setTopGainers(d.topGainers);
      if (d.traderResults) setTraderResults(d.traderResults);
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
            <h1 className="text-2xl font-bold">Trap Trader</h1>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <StatCard label="Balance" value={`$${fmt(status.balance)}`} />
          <StatCard label="Equity" value={`$${fmt(status.equity)}`} />
          <StatCard
            label="Net Profit"
            value={`$${fmt(performance.netProfit)}`}
            color={pnlColor(performance.netProfit)}
          />
          <StatCard label="Trades" value={performance.totalTrades} sub={`${fmt(performance.winRate)}% win rate`} />
          <StatCard label="Fees" value={`$${fmt(performance.feesPaid)}`} color="text-slate-400" />
          <StatCard
            label="Max Drawdown"
            value={`${fmt(performance.maxDrawdown)}%`}
            color="text-rose-400"
          />
        </div>

        {/* ── Win/Loss Streak ── */}
        <WinLossStreak results={traderResults} />

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
      </div>
    </div>
  );
}

export default App;
