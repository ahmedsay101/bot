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

function statusBadge(status) {
  if (status === "tp") return { label: "TP", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" };
  if (status === "sl") return { label: "SL", cls: "bg-rose-500/15 text-rose-400 border-rose-500/20" };
  if (status === "active") return { label: "OPEN", cls: "bg-sky-500/15 text-sky-400 border-sky-500/20" };
  return { label: "WAIT", cls: "bg-slate-700/50 text-slate-500 border-slate-600/20" };
}

/* â”€â”€ Stat Card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function StatCard({ label, value, sub, color }) {
  return (
    <div className="glass rounded-2xl p-5">
      <p className="text-[11px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color || "text-slate-100"}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/* â”€â”€ Ladder Visualization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function LadderBar({ trader }) {
  const price = Number(trader.lastPrice);
  const longs = trader.longs || [];
  const shorts = trader.shorts || [];
  const allPrices = [
    ...longs.map(o => o.stopPrice),
    ...shorts.map(o => o.stopPrice),
    price, Number(trader.startPrice)
  ].filter(Number.isFinite);
  if (allPrices.length === 0) return null;

  const low = Math.min(...allPrices) * 0.995;
  const high = Math.max(...allPrices) * 1.005;
  const range = high - low || 1;
  const pct = (v) => Math.max(0, Math.min(100, ((v - low) / range) * 100));

  return (
    <div className="relative h-4 w-full overflow-hidden rounded-full bg-slate-800">
      {/* Short zone markers (below price) */}
      {shorts.map((o, i) => {
        const badge = statusBadge(o.status);
        const color = o.status === "tp" ? "bg-emerald-400" : o.status === "sl" ? "bg-rose-400" : o.status === "active" ? "bg-sky-400" : "bg-slate-600";
        return <div key={`s${i}`} className={`absolute top-0 h-full w-1 rounded-full ${color}`} style={{ left: `${pct(o.stopPrice)}%` }} title={`SHORT #${i+1} ${o.status} @ ${fmtPrice(o.stopPrice)}`} />;
      })}
      {/* Long zone markers (above price) */}
      {longs.map((o, i) => {
        const color = o.status === "tp" ? "bg-emerald-400" : o.status === "sl" ? "bg-rose-400" : o.status === "active" ? "bg-sky-400" : "bg-amber-400";
        return <div key={`l${i}`} className={`absolute top-0 h-full w-1 rounded-full ${color}`} style={{ left: `${pct(o.stopPrice)}%` }} title={`LONG #${i+1} ${o.status} @ ${fmtPrice(o.stopPrice)}`} />;
      })}
      {/* Start price */}
      <div className="absolute top-0 h-full w-0.5 bg-white/30" style={{ left: `${pct(trader.startPrice)}%` }} title="Start price" />
      {/* Current price */}
      <div className="absolute top-0 h-full w-1.5 rounded-full bg-white shadow-lg shadow-white/30 transition-all" style={{ left: `calc(${pct(price)}% - 3px)` }} />
    </div>
  );
}

/* â”€â”€ Order Level Row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function OrderRow({ order, side }) {
  const badge = statusBadge(order.status);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={`w-5 text-right font-mono text-slate-500`}>#{order.idx + 1}</span>
      <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${badge.cls}`}>{badge.label}</span>
      <span className="font-mono text-slate-300 w-24">{fmtPrice(order.stopPrice)}</span>
      {order.status === "active" && (
        <>
          <span className="text-emerald-400/60 font-mono">TP {fmtPrice(order.tpPrice)}</span>
          <span className="text-rose-400/60 font-mono">SL {fmtPrice(order.slPrice)}</span>
        </>
      )}
    </div>
  );
}

/* â”€â”€ Trade History Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
            <th className="py-2 pr-3">Lvl</th>
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
              <td className="py-1.5 pr-3 font-mono text-slate-400">{t.level || "-"}</td>
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

/* â”€â”€ Trader Card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function TraderCard({ trader, onDestroy }) {
  const [expanded, setExpanded] = useState(false);
  const netPnl = (trader.realizedPnl || 0) + (trader.unrealizedPnl || 0);

  const longs = trader.longs || [];
  const shorts = trader.shorts || [];
  const longsDone = longs.filter(o => o.status === "tp" || o.status === "sl").length;
  const shortsDone = shorts.filter(o => o.status === "tp" || o.status === "sl").length;
  const longsActive = longs.filter(o => o.status === "active").length;
  const shortsActive = shorts.filter(o => o.status === "active").length;

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
              LADDER {trader.leverage || 2}x
            </span>
            {/* Side progress badges */}
            <span className="rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold">
              L {longsActive}A / {longsDone}D / {longs.length}
            </span>
            <span className="rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/20 px-2 py-0.5 text-[10px] font-bold">
              S {shortsActive}A / {shortsDone}D / {shorts.length}
            </span>
            <span className="text-[10px] text-slate-500">
              {trader.createdAt ? new Date(trader.createdAt).toLocaleString() : ""}
              {trader.createdAt ? ` Â· ${fmtDuration(trader.createdAt)}` : ""}
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

        {/* Accumulated TP/SL summary */}
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 text-emerald-400">
            TP: {trader.accumulatedTpCount || 0} (${fmt(trader.accumulatedTpPnl || 0, 4)})
          </span>
          <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2.5 py-1 text-rose-400">
            SL: {trader.accumulatedSlCount || 0} (${fmt(trader.accumulatedSlPnl || 0, 4)})
          </span>
          <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-slate-300">
            Trades: {trader.totalTrades || 0}
          </span>
        </div>

        {/* Ladder visualization bar */}
        <div className="mt-3">
          <LadderBar trader={trader} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-5 space-y-5">
          {/* Config Info */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-sm">
            <div>
              <p className="text-[10px] uppercase text-slate-500">Start Price</p>
              <p className="font-mono text-slate-200">{fmtPrice(trader.startPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Current Price</p>
              <p className="font-mono text-slate-200">{fmtPrice(trader.lastPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Levels</p>
              <p className="font-mono text-slate-200">{trader.ladderLevels || 10} / side</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Gap</p>
              <p className="font-mono text-slate-200">{trader.ladderGapPercent || 1}%</p>
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

          {/* Accumulated TP/SL stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/10 p-3">
              <p className="text-[10px] uppercase text-emerald-400/60">Accumulated TP</p>
              <p className="text-sm font-mono font-bold text-emerald-400">{trader.accumulatedTpCount || 0} hits</p>
              <p className="text-xs font-mono text-emerald-400/80">${fmt(trader.accumulatedTpPnl || 0, 4)}</p>
            </div>
            <div className="rounded-xl bg-rose-500/5 border border-rose-500/10 p-3">
              <p className="text-[10px] uppercase text-rose-400/60">Accumulated SL</p>
              <p className="text-sm font-mono font-bold text-rose-400">{trader.accumulatedSlCount || 0} hits</p>
              <p className="text-xs font-mono text-rose-400/80">${fmt(trader.accumulatedSlPnl || 0, 4)}</p>
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
          </div>

          {/* Ladder levels */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-emerald-400/60 mb-2">
                Long Orders ({longs.length})
              </h4>
              <div className="space-y-1 rounded-xl bg-slate-800/30 p-3">
                {longs.map((o) => <OrderRow key={o.idx} order={o} side="LONG" />)}
              </div>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-rose-400/60 mb-2">
                Short Orders ({shorts.length})
              </h4>
              <div className="space-y-1 rounded-xl bg-slate-800/30 p-3">
                {shorts.map((o) => <OrderRow key={o.idx} order={o} side="SHORT" />)}
              </div>
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

/* â”€â”€ Trader History Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
            <th className="py-2 pr-3 text-right">TP</th>
            <th className="py-2 pr-3 text-right">SL</th>
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
              <td className="py-1.5 pr-3 text-right font-mono text-emerald-400">
                {h.accumulatedTpCount || 0}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-rose-400">
                {h.accumulatedSlCount || 0}
              </td>
              <td className={`py-1.5 pr-3 text-right font-mono font-bold ${pnlColor(h.realizedPnl)}`}>
                ${fmt(h.realizedPnl, 4)}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-500">${fmt(h.feesPaid, 4)}</td>
              <td className="py-1.5 pr-3">
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                  h.reason === "take-profit" || h.reason === "all-closed"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : h.reason === "max-loss" || h.reason === "side-closed"
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

/* â”€â”€ Top Gainers Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€ App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

        {/* â”€â”€ Header â”€â”€ */}
        <div className="glass rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Ladder Trader</h1>
            <p className="text-xs text-slate-500 mt-1">
              Binance Futures Â· {status.mode}
              <span className="ml-3">{socketStatus === "connected" ? "â— Connected" : "â—‹ Disconnected"}</span>
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

        {/* â”€â”€ Main Stats Row â”€â”€ */}
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

        {/* â”€â”€ Top Gainers + Traders â”€â”€ */}
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

        {/* â”€â”€ Trader History â”€â”€ */}
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
