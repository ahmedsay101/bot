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

/* ── TP Progress Bar ───────────────────────────────────────── */
function TpProgress({ position, lastPrice }) {
  if (!position) return null;
  const entry = Number(position.entryPrice);
  const tp = Number(position.tpPrice);
  const price = Number(lastPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(price)) return null;

  const isLong = position.direction === "LONG";
  const totalRange = Math.abs(tp - entry);
  const priceMove = isLong ? price - entry : entry - price;
  const ratio = totalRange > 0 ? priceMove / totalRange : 0;
  const pct = Math.max(-100, Math.min(200, Math.round(ratio * 100)));
  const barPct = Math.max(0, Math.min(100, pct));

  const barColor =
    pct >= 75 ? "bg-emerald-400" : pct >= 25 ? "bg-sky-400" : pct >= 0 ? "bg-amber-400" : "bg-rose-500";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
        <span>{position.direction} → TP</span>
        <span className={pct >= 0 ? "text-emerald-400" : "text-rose-400"}>{pct}%</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${barPct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-600">
        <span>Entry {fmtPrice(entry)}</span>
        <span>TP {fmtPrice(tp)}</span>
      </div>
    </div>
  );
}

/* ── Position Info ─────────────────────────────────────────── */
function PositionInfo({ position, lastPrice, leverage, notional }) {
  if (!position) return (
    <div className="rounded-xl bg-slate-800/50 p-4 text-center text-sm text-slate-500">
      No open position
    </div>
  );

  const entry = Number(position.entryPrice);
  const price = Number(lastPrice);
  const qty = Number(position.quantity);
  const dir = position.direction === "LONG" ? 1 : -1;
  const unrealizedPnl = Number.isFinite(entry) && Number.isFinite(price) && Number.isFinite(qty)
    ? (price - entry) * qty * dir : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase ${
          position.direction === "LONG"
            ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
            : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
        }`}>
          {position.direction}
        </span>
        <span className="text-xs text-slate-500">#{position.tradeNumber}</span>
        <span className="text-xs text-slate-500">·</span>
        <span className="text-xs text-slate-500">{position.openReason}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-[10px] uppercase text-slate-500">Entry</p>
          <p className="font-mono text-slate-200">{fmtPrice(entry)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-slate-500">Current</p>
          <p className="font-mono text-slate-200">{fmtPrice(price)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-slate-500">Take Profit</p>
          <p className="font-mono text-emerald-400">{fmtPrice(position.tpPrice)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-slate-500">Stop Loss</p>
          <p className="font-mono text-rose-400">{fmtPrice(position.slPrice)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-slate-500">Qty</p>
          <p className="font-mono text-slate-200">{fmt(qty, 4)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-slate-500">Unrealized PnL</p>
          <p className={`font-mono font-bold ${pnlColor(unrealizedPnl)}`}>${fmt(unrealizedPnl, 4)}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span>Leverage {leverage}x</span>
        <span>·</span>
        <span>Notional ${fmt(notional)}</span>
      </div>

      <TpProgress position={position} lastPrice={lastPrice} />
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
            <th className="py-2 pr-3 text-right">Notional</th>
            <th className="py-2 pr-3 text-right">Gross PnL</th>
            <th className="py-2 pr-3 text-right">Fees</th>
            <th className="py-2 text-right">Net PnL</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice().reverse().map((t, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-1.5 pr-3 text-slate-500">{t.tradeNumber ?? "-"}</td>
              <td className="py-1.5 pr-3">
                <span className={t.direction === "LONG" ? "text-emerald-400" : "text-rose-400"}>
                  {t.direction}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-slate-400">{t.reason || t.openReason}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-300">{fmtPrice(t.entry)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-300">{fmtPrice(t.exit)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-400">{fmt(t.quantity, 4)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-slate-400">${fmt(t.notional)}</td>
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
  const pos = trader.position;

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
            <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-400 border border-sky-500/20">
              PERPETUAL
            </span>
            {pos && (
              <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${
                pos.direction === "LONG"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-rose-500/15 text-rose-400"
              }`}>
                {pos.direction}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-slate-300">
                {trader.wins ?? 0}W / {trader.losses ?? 0}L
              </span>
              <span className={`rounded-full bg-white/5 border border-white/10 px-2.5 py-1 ${pnlColor(trader.realizedPnl)}`}>
                PnL ${fmt(trader.realizedPnl)}
              </span>
              <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-slate-400">
                {trader.leverage}x · ${fmt(trader.notional)}
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

        {/* Current position mini-view */}
        {pos && (
          <div className="mt-3">
            <TpProgress position={pos} lastPrice={trader.lastPrice} />
          </div>
        )}
      </button>

      {expanded && (
        <div className="border-t border-white/5 p-5 space-y-5">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Current Position</h4>
            <PositionInfo
              position={pos}
              lastPrice={trader.lastPrice}
              leverage={trader.leverage}
              notional={trader.notional}
            />
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
              Trade History ({trader.totalTrades ?? trader.tradeHistory?.length ?? 0})
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
                <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[9px] font-bold uppercase text-sky-400">
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

  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">

        {/* ── Header ── */}
        <div className="glass rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Perpetual Trader</h1>
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
          <StatCard label="Wins" value={performance.wins ?? 0} color="text-emerald-400" />
          <StatCard label="Losses" value={performance.losses ?? 0} color="text-rose-400" />
          <StatCard label="Active Traders" value={traders.length} sub={`of ${status.maxTraders} max`} />
          <StatCard
            label="Net Profit"
            value={`$${fmt(performance.netProfit)}`}
            color={pnlColor(performance.netProfit)}
          />
          <StatCard
            label="Win Rate"
            value={`${fmt(performance.winRate)}%`}
            sub={`${performance.totalTrades} total trades`}
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
