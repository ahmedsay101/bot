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

/* ── Price Level Indicator ──────────────────────────────────── */
/**
 * A simple 3-zone gauge that tells you at a glance:
 *   • where the price is (green pointer + % move from entry)
 *   • how close it is to TP (left edge) or hedge trigger (right edge)
 *   • whether the hedge is currently open (with its SL marker)
 *
 * Zones, left → right:
 *   [ PROFIT ] entry [ WATCHING ] +5% trigger [ HEDGED ]
 */
function PriceLevelIndicator({ trader }) {
  const price = Number(trader.lastPrice);
  const tp = Number(trader.tpPrice);
  const entry = Number(trader.entryPrice);
  if (!Number.isFinite(price) || !Number.isFinite(tp) || !Number.isFinite(entry)) return null;

  const triggerPct = Number(trader.hedgeTriggerPercent) || 5;
  const tpPct = Number(trader.takeProfitPercent) || 10;
  const trigger = entry * (1 + triggerPct / 100);
  const hedge = trader.hedge || null;

  // Render scale: a bit of headroom on both ends so markers near the edges
  // don't get clipped, and so a runaway price still appears at the far right.
  const lo = tp * 0.98;
  const hi = Math.max(trigger, price, hedge ? hedge.entryPrice : 0) * 1.02;
  const range = hi - lo || 1;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / range) * 100));

  const moveFromEntry = ((price - entry) / entry) * 100;
  const hedged = !!hedge;

  // State label + color drives the price-pill style
  let stateLabel, stateColor;
  if (hedged) { stateLabel = "HEDGED"; stateColor = "bg-sky-500"; }
  else if (price <= entry) { stateLabel = "IN PROFIT"; stateColor = "bg-emerald-500"; }
  else if (price < trigger) { stateLabel = "WATCHING"; stateColor = "bg-amber-500"; }
  else { stateLabel = "TRIGGERING"; stateColor = "bg-rose-500"; }

  const tpLeft = pct(tp);
  const entryLeft = pct(entry);
  const triggerLeft = pct(trigger);
  const priceLeft = pct(price);

  return (
    <div className="space-y-2">
      {/* The bar itself: three colored zones separated by entry & trigger */}
      <div className="relative h-8 w-full rounded-md bg-slate-800/60 ring-1 ring-white/5">
        {/* Profit zone (TP side, left of entry) */}
        <div
          className="absolute top-0 h-full rounded-l-md bg-emerald-500/15"
          style={{ left: `${tpLeft}%`, width: `${Math.max(0, entryLeft - tpLeft)}%` }}
        />
        {/* Watching zone (entry → hedge trigger) */}
        <div
          className="absolute top-0 h-full bg-amber-500/15"
          style={{ left: `${entryLeft}%`, width: `${Math.max(0, triggerLeft - entryLeft)}%` }}
        />
        {/* Hedged zone (above trigger) */}
        <div
          className="absolute top-0 h-full rounded-r-md bg-rose-500/15"
          style={{ left: `${triggerLeft}%`, right: 0 }}
        />

        {/* Vertical reference lines */}
        <div className="absolute top-0 h-full w-px bg-emerald-400/70" style={{ left: `${tpLeft}%` }} />
        <div className="absolute top-0 h-full w-px bg-amber-400/70" style={{ left: `${entryLeft}%` }} />
        <div className="absolute top-0 h-full w-px bg-rose-400/70" style={{ left: `${triggerLeft}%` }} />

        {/* Hedge SL marker (only when a hedge is open) */}
        {hedged && (
          <div
            className="absolute top-0 h-full w-px bg-sky-400/80"
            style={{ left: `${pct(hedge.slPrice)}%` }}
            title={`Hedge SL ${fmtPrice(hedge.slPrice)}`}
          />
        )}

        {/* Price marker */}
        <div
          className="absolute -top-1 flex h-10 -translate-x-1/2 flex-col items-center"
          style={{ left: `${priceLeft}%` }}
        >
          <div className={`h-10 w-1 rounded-full ${stateColor} shadow-md`} />
        </div>
      </div>

      {/* Zone labels under the bar — anchored to each segment */}
      <div className="relative h-4 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        <span className="absolute -translate-x-1/2 text-emerald-400" style={{ left: `${(tpLeft + entryLeft) / 2}%` }}>Profit</span>
        <span className="absolute -translate-x-1/2 text-amber-400" style={{ left: `${(entryLeft + triggerLeft) / 2}%` }}>Watching</span>
        <span className="absolute -translate-x-1/2 text-rose-400" style={{ left: `${(triggerLeft + 100) / 2}%` }}>Hedged</span>
      </div>

      {/* Reference prices row */}
      <div className="flex justify-between text-[11px] font-mono">
        <div className="text-emerald-400">
          <span className="text-slate-500 mr-1">TP</span>{fmtPrice(tp)} <span className="text-slate-500">(-{fmt(tpPct)}%)</span>
        </div>
        <div className="text-amber-400">
          <span className="text-slate-500 mr-1">Entry</span>{fmtPrice(entry)}
        </div>
        <div className="text-rose-400">
          <span className="text-slate-500 mr-1">Hedge @</span>{fmtPrice(trigger)} <span className="text-slate-500">(+{fmt(triggerPct)}%)</span>
        </div>
      </div>

      {/* Live price + state pill */}
      <div className="flex items-center justify-between text-xs">
        <div className="font-mono text-slate-300">
          Price <span className="text-slate-100">{fmtPrice(price)}</span>{" "}
          <span className={moveFromEntry >= 0 ? "text-rose-400" : "text-emerald-400"}>
            ({moveFromEntry >= 0 ? "+" : ""}{fmt(moveFromEntry)}%)
          </span>
        </div>
        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white ${stateColor}`}>
          {stateLabel}
        </span>
      </div>
    </div>
  );
}

/* ── Trade History Table ───────────────────────────────────── */
function TradeTable({ trades }) {
  if (!trades || trades.length === 0) return (
    <p className="py-3 text-center text-xs text-slate-600">No closed trades yet</p>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/5 text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-2 pr-3">#</th>
            <th className="py-2 pr-3">Direction</th>
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
          {trades.slice().reverse().map((t, i) => {
            const isHedge = t.direction === "HEDGE_LONG";
            return (
              <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                <td className="py-1.5 pr-3 text-slate-500">{trades.length - i}</td>
                <td className="py-1.5 pr-3">
                  <span className={isHedge ? "text-sky-400" : "text-rose-400"}>{t.direction}</span>
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Trader Card ───────────────────────────────────────────── */
function TraderCard({ trader, onDestroy }) {
  const [expanded, setExpanded] = useState(false);
  const netPnl = (trader.realizedPnl || 0) + (trader.unrealizedPnl || 0);
  const lossPct = Number(trader.lossPercent) || 0;
  const hedgeActive = trader.hedge != null;

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
            <span className="rounded-full bg-rose-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-400 border border-rose-500/20">
              SHORT {trader.leverage || 2}x
            </span>
            {hedgeActive ? (
              <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-300 border border-sky-500/30">
                HEDGE LONG
              </span>
            ) : (
              <span className="rounded-full bg-slate-700/40 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border border-white/5">
                NO HEDGE
              </span>
            )}
            <span className="text-[10px] text-slate-500">
              {trader.createdAt ? `${new Date(trader.createdAt).toLocaleString()} · ${fmtDuration(trader.createdAt)}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-slate-300">
                Entry {fmtPrice(trader.entryPrice)}
              </span>
              <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 text-emerald-400">
                TP {fmtPrice(trader.tpPrice)}
              </span>
              <span className={`rounded-full bg-white/5 border border-white/10 px-2.5 py-1 ${lossPct >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {lossPct >= 0 ? "+" : ""}{fmt(lossPct)}%
              </span>
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

        <div className="mt-3">
          <PriceLevelIndicator trader={trader} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-5 space-y-5">
          {/* Short config */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Main SHORT</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-sm">
              <div>
                <p className="text-[10px] uppercase text-slate-500">Start Price</p>
                <p className="font-mono text-slate-200">{fmtPrice(trader.startPrice)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-slate-500">Current</p>
                <p className="font-mono text-slate-200">{fmtPrice(trader.lastPrice)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-slate-500">Entry</p>
                <p className="font-mono text-amber-400">{fmtPrice(trader.entryPrice)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-slate-500">TP ({fmt(trader.takeProfitPercent || 10)}%)</p>
                <p className="font-mono text-emerald-400">{fmtPrice(trader.tpPrice)}</p>
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
          </div>

          {/* Hedge */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
              Hedge ({trader.hedgeCount || 0} opened)
            </h4>
            {hedgeActive ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div className="rounded-xl bg-sky-500/10 border border-sky-500/20 p-3">
                  <p className="text-[10px] uppercase text-slate-500">Hedge Entry</p>
                  <p className="font-mono text-sky-300">{fmtPrice(trader.hedge.entryPrice)}</p>
                </div>
                <div className="rounded-xl bg-sky-500/5 border border-white/5 p-3">
                  <p className="text-[10px] uppercase text-slate-500">Hedge Qty</p>
                  <p className="font-mono text-slate-200">{fmt(trader.hedge.quantity, 4)}</p>
                </div>
                <div className="rounded-xl bg-rose-500/10 border border-rose-500/20 p-3">
                  <p className="text-[10px] uppercase text-slate-500">Hedge SL ({fmt(trader.hedgeStopLossPercent || 5)}%)</p>
                  <p className="font-mono text-rose-400">{fmtPrice(trader.hedge.slPrice)}</p>
                </div>
                <div className="rounded-xl bg-slate-800/40 p-3">
                  <p className="text-[10px] uppercase text-slate-500">Opened</p>
                  <p className="font-mono text-slate-300 text-xs">
                    {trader.hedge.openedAt ? new Date(trader.hedge.openedAt).toLocaleTimeString() : "-"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                No hedge open. Will open LONG when SHORT loss reaches{" "}
                <span className="text-violet-400">{fmt(trader.hedgeTriggerPercent || 5)}%</span>.
              </p>
            )}
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
              <p className="text-[10px] uppercase text-slate-500">Hedge Realized</p>
              <p className={`text-sm font-mono ${pnlColor(trader.hedgeRealizedPnl)}`}>
                ${fmt(trader.hedgeRealizedPnl, 4)}
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
              Closed Sub-Trades ({trader.tradeHistory?.length || 0})
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
            <th className="py-2 pr-3">24h %</th>
            <th className="py-2 pr-3 text-right">Entry</th>
            <th className="py-2 pr-3 text-right">Exit</th>
            <th className="py-2 pr-3 text-right">Hedges</th>
            <th className="py-2 pr-3 text-right">PnL</th>
            <th className="py-2 pr-3 text-right">Hedge PnL</th>
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
              <td className="py-1.5 pr-3 text-emerald-400">{fmt(h.changePercent)}%</td>
              <td className="py-1.5 pr-3 text-right font-mono text-amber-400">{fmtPrice(h.entryPrice || h.startPrice)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-400">{fmtPrice(h.endPrice)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-sky-300">{h.hedgeCount || 0}</td>
              <td className={`py-1.5 pr-3 text-right font-mono font-bold ${pnlColor(h.realizedPnl)}`}>
                ${fmt(h.realizedPnl, 4)}
              </td>
              <td className={`py-1.5 pr-3 text-right font-mono ${pnlColor(h.hedgeRealizedPnl)}`}>
                ${fmt(h.hedgeRealizedPnl, 4)}
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-500">${fmt(h.feesPaid, 4)}</td>
              <td className="py-1.5 pr-3">
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                  h.reason === "take-profit"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : h.reason === "manual"
                    ? "bg-amber-500/15 text-amber-400"
                    : h.reason === "max-hedges"
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
        const eligible = (g.percent || 0) > 60;
        return (
          <div
            key={g.symbol}
            className={`flex items-center justify-between rounded-xl px-4 py-2.5 ${
              eligible ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-slate-800/40"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-200">{g.symbol}</span>
              {hasTrader && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-400">
                  ACTIVE
                </span>
              )}
              {!hasTrader && eligible && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-bold uppercase text-emerald-400">
                  ELIGIBLE
                </span>
              )}
            </div>
            <span className={`text-sm font-bold ${eligible ? "text-emerald-400" : "text-slate-400"}`}>
              +{fmt(g.percent)}%
            </span>
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

  const hedgeCount = traders.filter((t) => t.hedge != null).length;

  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">

        {/* Header */}
        <div className="glass rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Short + Hedge Bot</h1>
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
            <span className="rounded-full bg-sky-500/10 border border-sky-500/20 px-3 py-1.5 text-sky-300">
              {hedgeCount} hedge{hedgeCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {/* Main Stats */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Balance" value={`$${fmt(status.balance)}`} />
          <StatCard label="Equity" value={`$${fmt(status.equity)}`} />
          <StatCard
            label="Net Profit"
            value={`$${fmt(performance.netProfit)}`}
            color={pnlColor(performance.netProfit)}
          />
          <StatCard
            label="Trades"
            value={performance.totalTrades}
            sub={`${fmt(performance.winRate)}% win rate`}
          />
          <StatCard label="Fees" value={`$${fmt(performance.feesPaid)}`} color="text-slate-400" />
        </div>

        {/* Traders + Top Gainers */}
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Active Traders</h2>
            {traders.length === 0 && (
              <div className="glass rounded-2xl p-8 text-center text-slate-500">
                No active traders. Waiting for symbols with 24h change &gt; 60%...
              </div>
            )}
            {traders.map((t) => (
              <TraderCard key={t.id} trader={t} onDestroy={handleDestroy} />
            ))}
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-4">Top Gainers (24h)</h2>
            <p className="text-[10px] text-slate-500 mb-2">
              Eligibility: 24h change &gt; <span className="text-emerald-400 font-semibold">60%</span>
            </p>
            <div className="glass rounded-2xl p-4">
              <TopGainersTable gainers={topGainers} activeSymbols={activeSymbols} />
            </div>
          </div>
        </div>

        {/* Trader History */}
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
