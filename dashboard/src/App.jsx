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

/* ── Take Profit Progress Bar ──────────────────────────────── */
function TakeProfitProgress({ takeProfitTarget, takeProfitProgress, unrealizedPnl, realizedPnl }) {
  const target = Number(takeProfitTarget) || 0;
  const progress = Math.min(100, Math.max(0, Number(takeProfitProgress) || 0));
  const netPnl = Number(realizedPnl || 0) + Number(unrealizedPnl || 0);
  const barColor = netPnl >= 0 ? "bg-emerald-400" : "bg-rose-500";
  const textColor = netPnl >= 0 ? "text-emerald-400" : "text-rose-400";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
        <span>Take Profit Target (${fmt(target)})</span>
        <span className={textColor}>Net P&L ${fmt(netPnl)}</span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-600">
        <span>Start</span>
        <span>{fmt(progress)}% toward target</span>
      </div>
    </div>
  );
}

/* ── Grid Levels Table ─────────────────────────────────────── */
function GridLevels({ levels, lastPrice }) {
  if (!levels || levels.length === 0) return (
    <p className="py-3 text-center text-xs text-slate-600">No levels</p>
  );

  // Sort by price descending (highest first)
  const sorted = [...levels].sort((a, b) => b.price - a.price);

  return (
    <div className="overflow-x-auto max-h-80 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-900/95">
          <tr className="border-b border-white/5 text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-2 pr-3">Level</th>
            <th className="py-2 pr-3">Price</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Entry</th>
            <th className="py-2 pr-3 text-right">SL</th>
            <th className="py-2 pr-3 text-right">Qty</th>
            <th className="py-2 text-right">Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((level) => {
            const isNearPrice = lastPrice && Math.abs(level.price - lastPrice) / lastPrice < 0.005;
            const statusColors = {
              filled: "bg-rose-500/20 text-rose-400 border-rose-500/30",
              pending: "bg-amber-500/20 text-amber-400 border-amber-500/30",
              closed: "bg-slate-500/20 text-slate-500 border-slate-500/30",
              empty: "bg-slate-800/50 text-slate-600 border-slate-700/30"
            };
            const statusColor = statusColors[level.status] || statusColors.empty;

            return (
              <tr key={level.index}
                className={`border-b border-white/[0.03] hover:bg-white/[0.02] ${isNearPrice ? "bg-sky-500/5" : ""}`}
              >
                <td className="py-1.5 pr-3 font-mono text-slate-400">L{level.index}</td>
                <td className="py-1.5 pr-3 font-mono text-slate-300">{fmtPrice(level.price)}</td>
                <td className="py-1.5 pr-3">
                  <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase ${statusColor}`}>
                    {level.status}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-slate-300">
                  {level.entryPrice ? fmtPrice(level.entryPrice) : "-"}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-rose-400">
                  {level.stopLossPrice ? fmtPrice(level.stopLossPrice) : "-"}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-slate-400">
                  {level.quantity ? fmt(level.quantity, 4) : "-"}
                </td>
                <td className={`py-1.5 text-right font-mono font-bold ${level.unrealizedPnl != null ? pnlColor(level.unrealizedPnl) : "text-slate-600"}`}>
                  {level.unrealizedPnl != null ? `$${fmt(level.unrealizedPnl, 4)}` : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Trade History Table ───────────────────────────────────── */
function TradeTable({ trades }) {
  if (!trades || trades.length === 0) return (
    <p className="py-3 text-center text-xs text-slate-600">No trades yet</p>
  );

  return (
    <div className="overflow-x-auto max-h-60 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-900/95">
          <tr className="border-b border-white/5 text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-2 pr-3">Level</th>
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
              <td className="py-1.5 pr-3 font-mono text-slate-400">L{t.levelIndex}</td>
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
  const filledCount = (trader.levels || []).filter((l) => l.status === "filled").length;
  const pendingCount = (trader.levels || []).filter((l) => l.status === "pending").length;

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
            <span className="rounded-full bg-violet-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-400 border border-violet-500/20">
              GRID SHORT
            </span>
            <span className="text-xs text-slate-500">
              {trader.leverage}x
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-rose-400">
                {filledCount} open
              </span>
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-amber-400">
                {pendingCount} pending
              </span>
              <span className={`rounded-full bg-white/5 border border-white/10 px-2.5 py-1 ${pnlColor(trader.realizedPnl)}`}>
                Realized ${fmt(trader.realizedPnl)}
              </span>
              <span className={`rounded-full bg-white/5 border border-white/10 px-2.5 py-1 ${pnlColor(trader.unrealizedPnl)}`}>
                Unrealized ${fmt(trader.unrealizedPnl)}
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

        {/* Price info & destroy progress */}
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-slate-500">Start Price</span>
              <p className="font-mono text-slate-200">{fmtPrice(trader.startPrice)}</p>
            </div>
            <div>
              <span className="text-slate-500">Current Price</span>
              <p className="font-mono text-slate-200">{fmtPrice(trader.lastPrice)}</p>
            </div>
            <div>
              <span className="text-slate-500">Highest</span>
              <p className="font-mono text-slate-200">{fmtPrice(trader.highestPrice)}</p>
            </div>
            <div>
              <span className="text-slate-500">Lowest</span>
              <p className="font-mono text-slate-200">{fmtPrice(trader.lowestPrice)}</p>
            </div>
          </div>
          <TakeProfitProgress
            takeProfitTarget={trader.takeProfitTarget}
            takeProfitProgress={trader.takeProfitProgress}
            unrealizedPnl={trader.unrealizedPnl}
            realizedPnl={trader.realizedPnl}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-5 space-y-5">
          {/* Config summary */}
          <div className="flex flex-wrap gap-3 text-xs text-slate-400">
            <span>Spacing: {fmt(trader.spacingPercent)}%</span>
            <span>·</span>
            <span>Max Open: {trader.maxOpenTransactions}</span>
            <span>·</span>
            <span>Window: {trader.levelWindow}</span>
            <span>·</span>
            <span>SL: {fmt(trader.stopLossPercent)}%</span>
            <span>·</span>
            <span>Fees: ${fmt(trader.feesPaid, 4)}</span>
            <span>·</span>
            <span>Closed Trades: {trader.tradeHistory?.length || 0}</span>
          </div>

          {/* Grid Levels */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
              Grid Levels ({(trader.levels || []).length})
            </h4>
            <GridLevels levels={trader.levels} lastPrice={trader.lastPrice} />
          </div>

          {/* Trade History */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
              Trade History ({trader.tradeHistory?.length || 0})
            </h4>
            <TradeTable trades={trader.tradeHistory} />
          </div>
        </div>
      )}
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
                <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[9px] font-bold uppercase text-violet-400">
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

  const totalOpen = traders.reduce((s, t) => s + (t.openPositions || 0), 0);
  const totalPending = traders.reduce((s, t) => s + (t.pendingOrders || 0), 0);

  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">

        {/* ── Header ── */}
        <div className="glass rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Grid Short Trader</h1>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-7">
          <StatCard label="Balance" value={`$${fmt(status.balance)}`} />
          <StatCard label="Equity" value={`$${fmt(status.equity)}`} />
          <StatCard label="Open Pos." value={totalOpen} color="text-rose-400" />
          <StatCard label="Pending" value={totalPending} color="text-amber-400" />
          <StatCard label="Trades" value={performance.totalTrades} />
          <StatCard
            label="Net Profit"
            value={`$${fmt(performance.netProfit)}`}
            color={pnlColor(performance.netProfit)}
          />
          <StatCard
            label="Max DD"
            value={`${fmt(performance.maxDrawdown)}%`}
            color="text-rose-400"
          />
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
      </div>
    </div>
  );
}

export default App;
