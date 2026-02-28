import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar
} from "recharts";

const API_URL = import.meta.env.VITE_API_URL || "";

function fmt(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(digits);
}

function fmtPrice(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function pnlColor(v) {
  return Number(v) >= 0 ? "text-emerald-300" : "text-rose-300";
}

function dirColor(dir) {
  return dir === "LONG" ? "text-emerald-400" : "text-rose-400";
}

function dirBg(dir) {
  return dir === "LONG"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    : "bg-rose-500/15 text-rose-300 border-rose-500/30";
}

function streakText(streak) {
  if (!streak || streak === 0) return { label: "-", className: "text-slate-400" };
  if (streak > 0) return { label: `${streak}W`, className: "text-emerald-400" };
  return { label: `${Math.abs(streak)}L`, className: "text-rose-400" };
}

/* ------------------------------------------------------------------ */

function App() {
  const [status, setStatus] = useState({
    mode: "TEST", balance: 0, equity: 0, pnlToday: 0,
    activeTraders: 0, maxTraders: 0, perpetualStats: null
  });
  const [traders, setTraders] = useState([]);
  const [perf, setPerf] = useState({
    totalTrades: 0, winRate: 0, grossProfit: 0, grossLoss: 0,
    netProfit: 0, feesPaid: 0, maxDrawdown: 0, unrealizedPnl: 0,
    grossProfitLive: 0, grossLossLive: 0, netProfitLive: 0
  });
  const [mktStatus, setMktStatus] = useState({ api: "unknown", ws: "unknown" });
  const [sockStatus, setSockStatus] = useState("disconnected");
  const [eqSeries, setEqSeries] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const [topGainers, setTopGainers] = useState([]);

  const eqData = useMemo(() => eqSeries.slice(-120), [eqSeries]);

  /* ---------- initial load ---------- */
  useEffect(() => {
    Promise.all([
      axios.get(`${API_URL}/api/status`),
      axios.get(`${API_URL}/api/traders`),
      axios.get(`${API_URL}/api/performance`)
    ]).then(([s, t, p]) => {
      setStatus(s.data);
      if (s.data.marketStatus) setMktStatus(s.data.marketStatus);
      setTraders(t.data);
      setPerf(prev => ({ ...prev, ...(p.data || {}) }));
    }).catch(() => setSockStatus("error"));
  }, []);

  /* ---------- socket ---------- */
  useEffect(() => {
    const socket = io(API_URL, { path: "/api/socket.io", transports: ["websocket"] });
    socket.on("connect", () => setSockStatus("connected"));
    socket.on("disconnect", () => setSockStatus("disconnected"));

    socket.on("dashboardUpdate", (d) => {
      const nextTraders = d.traders || [];
      const bal = Number(d.balance || 0);
      const unr = nextTraders.reduce((s, t) => s + Number(t.unrealizedPnl || 0), 0);
      const eq = bal + unr;
      setTraders(nextTraders);
      setPerf(prev => ({ ...prev, ...(d.performance || {}) }));
      setMktStatus(prev => d.marketStatus || prev);
      if (d.topGainers) setTopGainers(d.topGainers);
      setStatus(prev => ({ ...prev, ...(d.status || {}), balance: bal, equity: eq }));
      setEqSeries(prev => [...prev, { time: new Date().toLocaleTimeString(), equity: eq }].slice(-200));
    });

    socket.on("priceUpdate", ({ symbol, price }) => {
      if (!symbol || !Number.isFinite(Number(price))) return;
      setTraders(prev => prev.map(t => t.symbol === symbol ? { ...t, lastPrice: Number(price) } : t));
    });

    return () => socket.disconnect();
  }, []);

  /* ---------- derived ---------- */
  const pStats = status.perpetualStats || {
    totalDestroyedTraders: 0, totalTradesAllTime: 0,
    totalWinsAllTime: 0, totalLossesAllTime: 0, totalPnlAllTime: 0
  };

  // Aggregate live stats across active traders
  const liveStats = useMemo(() => {
    let totalTrades = 0, wins = 0, losses = 0;
    traders.forEach(t => {
      totalTrades += t.totalTrades || 0;
      wins += t.wins || 0;
      losses += t.losses || 0;
    });
    return { totalTrades, wins, losses };
  }, [traders]);

  // Combined stats: destroyed + active
  const combinedTrades = pStats.totalTradesAllTime + liveStats.totalTrades;
  const combinedWins = pStats.totalWinsAllTime + liveStats.wins;
  const combinedLosses = pStats.totalLossesAllTime + liveStats.losses;
  const combinedWinRate = combinedTrades > 0 ? (combinedWins / combinedTrades) * 100 : 0;

  // Trade history chart: last 30 trades of all traders combined
  const tradeHistoryChart = useMemo(() => {
    const all = [];
    traders.forEach(t => {
      (t.tradeHistory || []).forEach(tr => all.push(tr));
    });
    return all.slice(-30).map((tr, i) => ({
      idx: i + 1,
      pnl: Number(tr.netPnl || 0)
    }));
  }, [traders]);

  const winLossData = [
    { name: "Wins", value: combinedWins || 0 },
    { name: "Losses", value: combinedLosses || 0 }
  ];

  const totalOpen = traders.reduce((s, t) => s + Number(t.openPositions || 0), 0);
  const detailTrader = detailId ? traders.find(t => t.id === detailId) : null;

  const formattedGainers = (Array.isArray(topGainers) ? topGainers : []).map(g => ({
    symbol: g.symbol, percent: Number(g.percent) || 0
  }));

  /* ================================================================ */
  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-6 pb-16 pt-8 lg:grid-cols-[260px_1fr]">

        {/* ==================== SIDEBAR ==================== */}
        <aside className="glass animate-fade-up sticky top-6 h-fit rounded-3xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Command</p>
              <h1 className="text-xl font-semibold">Perpetual Bot</h1>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-slate-300">v3.0</span>
          </div>

          <div className="mt-6 space-y-4">
            <SidebarCard label="Mode" value={status.mode} className={status.mode === "LIVE" ? "text-emerald-300" : "text-amber-300"} />
            <SidebarCard label="Equity" value={`$${fmt(status.equity)}`} />
            <SidebarCard label="Today PnL" value={`$${fmt(status.pnlToday)}`} className={pnlColor(status.pnlToday)} />
            <SidebarCard label="Fees Paid" value={`$${fmt(perf.feesPaid)}`} className="text-orange-300" />
          </div>

          <div className="mt-6 space-y-3 text-xs text-slate-400">
            <StatusRow label="API" value={mktStatus.api} />
            <StatusRow label="Socket" value={sockStatus} />
          </div>

          <div className="mt-6 rounded-2xl border border-white/5 bg-ink-800/70 px-4 py-3">
            <p className="text-xs text-slate-400">Strategy</p>
            <p className="text-lg font-semibold text-cyan-300">PERPETUAL</p>
            <p className="mt-1 text-[10px] text-slate-500">TP → Same dir · SL → Flip dir</p>
          </div>
        </aside>

        {/* ==================== MAIN ==================== */}
        <main className="flex flex-col gap-6">

          {/* Header */}
          <header className="glass animate-fade-up flex flex-wrap items-center justify-between gap-4 rounded-3xl px-6 py-5">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Operations Dashboard</p>
              <h2 className="text-2xl font-semibold">Binance Futures Perpetual</h2>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Pill>Balance ${fmt(status.balance)}</Pill>
              <Pill>Active {traders.length}/{status.maxTraders}</Pill>
              <Pill>Open {totalOpen}</Pill>
              <Pill>Total Trades {combinedTrades}</Pill>
            </div>
          </header>

          {/* KPI Cards */}
          <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard delay="0.05s" label="Win Rate" value={`${fmt(combinedWinRate)}%`} sub={`${combinedWins}W / ${combinedLosses}L of ${combinedTrades}`} />
            <KpiCard delay="0.1s" label="Net Profit" value={`$${fmt(perf.netProfitLive)}`} valueClass={pnlColor(perf.netProfitLive)} sub="Live incl. unrealized" />
            <KpiCard delay="0.15s" label="Fees Paid" value={`$${fmt(perf.feesPaid)}`} valueClass="text-orange-300" sub={`Gross Loss $${fmt(perf.grossLossLive)}`} />
            <KpiCard delay="0.2s" label="Max Drawdown" value={`${fmt(perf.maxDrawdown)}%`} valueClass="text-amber-300" sub={`Balance $${fmt(status.balance)}`} />
          </section>

          {/* Equity + Win/Loss */}
          <section className="grid gap-6 xl:grid-cols-3">
            <div className="glass animate-fade-up rounded-3xl p-6 xl:col-span-2" style={{ animationDelay: "0.25s" }}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Equity Curve</h3>
                <span className="text-xs text-slate-400">Last 120 ticks</span>
              </div>
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={eqData}>
                    <XAxis dataKey="time" hide />
                    <YAxis hide />
                    <Tooltip contentStyle={{ background: "#0c0f14", border: "1px solid #1f2838" }} />
                    <Line type="monotone" dataKey="equity" stroke="#7dd3fc" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.3s" }}>
              <h3 className="text-lg font-semibold">Win vs Loss</h3>
              <div className="mt-4 h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={winLossData} dataKey="value" innerRadius={45} outerRadius={80} paddingAngle={2}>
                      <Cell fill="#34d399" />
                      <Cell fill="#f87171" />
                    </Pie>
                    <Tooltip contentStyle={{ background: "#0c0f14", border: "1px solid #1f2838" }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex justify-center gap-4 text-xs">
                <span className="text-emerald-400">{combinedWins} Wins</span>
                <span className="text-rose-400">{combinedLosses} Losses</span>
              </div>
              <p className="mt-1 text-center text-xs text-slate-400">Win rate: {fmt(combinedWinRate)}%</p>

              {/* Recent trade PnL bar chart */}
              {tradeHistoryChart.length > 0 && (
                <>
                  <p className="mt-4 text-xs font-semibold text-slate-400">Recent Trade PnL</p>
                  <div className="mt-2 h-28">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={tradeHistoryChart}>
                        <XAxis dataKey="idx" hide />
                        <YAxis hide />
                        <Tooltip contentStyle={{ background: "#0c0f14", border: "1px solid #1f2838" }} />
                        <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                          {tradeHistoryChart.map((entry, idx) => (
                            <Cell key={idx} fill={entry.pnl >= 0 ? "#34d399" : "#f87171"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </div>
          </section>

          {/* Active Traders + Stats */}
          <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">

            {/* Traders list */}
            <div className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.35s" }}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Active Traders</h3>
                <span className="text-sm text-slate-400">{traders.length} / {status.maxTraders}</span>
              </div>

              <div className="mt-4 grid gap-4">
                {traders.map(t => {
                  const pos = t.position;
                  const netPnl = Number(t.realizedPnl || 0) + Number(t.unrealizedPnl || 0);
                  const tWinRate = t.totalTrades > 0 ? ((t.wins / t.totalTrades) * 100) : 0;
                  const streak = streakText(t.currentStreak);

                  return (
                    <button
                      key={t.id}
                      type="button"
                      className="rounded-2xl border border-white/5 bg-ink-800/60 p-4 text-left transition hover:bg-ink-800/80"
                      onClick={() => setDetailId(t.id)}
                    >
                      {/* Top row: symbol + badges + destroy */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <h4 className="text-lg font-semibold">{t.symbol}</h4>
                          <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-cyan-300">
                            Perpetual
                          </span>
                          {t.leverage && (
                            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-300">
                              {t.leverage}x
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/30"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!window.confirm(`Destroy trader for ${t.symbol}?`)) return;
                            axios.delete(`${API_URL}/api/traders/${t.symbol}`).catch(() => {});
                          }}
                        >
                          Destroy
                        </button>
                      </div>

                      {/* Stats row */}
                      <div className="mt-3 grid grid-cols-4 gap-2">
                        <MiniStat label="Trades" value={t.totalTrades || 0} />
                        <MiniStat label="Win Rate" value={`${fmt(tWinRate, 1)}%`} valueClass={tWinRate >= 50 ? "text-emerald-300" : "text-rose-300"} />
                        <MiniStat label="Streak" value={streak.label} valueClass={streak.className} />
                        <MiniStat label="Same Dir" value={t.consecutiveSameDir || 0} valueClass="text-cyan-300" />
                      </div>

                      {/* Position info */}
                      {pos && pos.direction && (
                        <div className="mt-3 rounded-2xl bg-ink-900/70 px-4 py-3">
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className={`rounded px-2 py-0.5 text-xs font-bold border ${dirBg(pos.direction)}`}>
                                {pos.direction}
                              </span>
                              <span className="text-slate-500 text-xs">#{pos.tradeNumber}</span>
                            </div>
                            <span className="text-slate-400">Entry {fmtPrice(pos.entryPrice)}</span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                            <div className="flex items-center justify-between rounded-xl bg-emerald-500/10 px-3 py-1.5">
                              <span className="text-emerald-400">TP</span>
                              <span className="text-emerald-300">{fmtPrice(pos.tpPrice)}</span>
                            </div>
                            <div className="flex items-center justify-between rounded-xl bg-rose-500/10 px-3 py-1.5">
                              <span className="text-rose-400">SL</span>
                              <span className="text-rose-300">{fmtPrice(pos.slPrice)}</span>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                            <span>Price {fmtPrice(t.lastPrice)}</span>
                            <span className={pnlColor(t.unrealizedPnl)}>
                              Unrealized ${fmt(t.unrealizedPnl, 4)}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* PnL badges */}
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                        <span className={`rounded-full border border-white/10 bg-white/5 px-3 py-1 ${pnlColor(t.unrealizedPnl)}`}>
                          Unrealized ${fmt(t.unrealizedPnl, 4)}
                        </span>
                        <span className={`rounded-full border border-white/10 bg-white/5 px-3 py-1 ${pnlColor(t.realizedPnl)}`}>
                          Realized ${fmt(t.realizedPnl, 4)}
                        </span>
                        <span className={`rounded-full border border-white/10 bg-white/5 px-3 py-1 ${pnlColor(netPnl)}`}>
                          Net ${fmt(netPnl, 4)}
                        </span>
                        {t.feesPaid != null && (
                          <span className="rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-orange-300">
                            Fees ${fmt(t.feesPaid, 4)}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
                {traders.length === 0 && (
                  <p className="py-6 text-center text-sm text-slate-500">No active traders yet.</p>
                )}
              </div>
            </div>

            {/* Perpetual Statistics */}
            <div className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.4s" }}>
              <h3 className="text-lg font-semibold">Statistics</h3>

              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-2xl bg-ink-800/70 p-3">
                  <p className="text-xs text-slate-400">Trades</p>
                  <p className="text-xl font-semibold">{combinedTrades}</p>
                </div>
                <div className="rounded-2xl bg-ink-800/70 p-3">
                  <p className="text-xs text-emerald-400">Wins</p>
                  <p className="text-xl font-semibold text-emerald-300">{combinedWins}</p>
                </div>
                <div className="rounded-2xl bg-ink-800/70 p-3">
                  <p className="text-xs text-rose-400">Losses</p>
                  <p className="text-xl font-semibold text-rose-300">{combinedLosses}</p>
                </div>
              </div>

              {/* Per-trader streaks */}
              <div className="mt-4 space-y-2">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Trader Streaks</p>
                {traders.length > 0 ? (
                  <div className="rounded-2xl border border-white/5 bg-ink-800/60 overflow-hidden">
                    {traders.map(t => {
                      const streak = streakText(t.currentStreak);
                      return (
                        <div key={t.id} className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 last:border-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-slate-300">{t.symbol}</span>
                            {t.position?.direction && (
                              <span className={`text-[10px] font-bold ${dirColor(t.position.direction)}`}>
                                {t.position.direction}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-slate-400">{t.wins || 0}W/{t.losses || 0}L</span>
                            <span className={`font-bold ${streak.className}`}>{streak.label}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No active traders.</p>
                )}
              </div>

              {/* Longest streaks across traders */}
              {traders.length > 0 && (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-2xl bg-ink-800/70 p-3 text-center">
                    <p className="text-[10px] uppercase text-slate-500">Best Win Streak</p>
                    <p className="text-lg font-bold text-emerald-300">
                      {Math.max(0, ...traders.map(t => t.longestWinStreak || 0))}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-ink-800/70 p-3 text-center">
                    <p className="text-[10px] uppercase text-slate-500">Worst Loss Streak</p>
                    <p className="text-lg font-bold text-rose-300">
                      {Math.max(0, ...traders.map(t => t.longestLossStreak || 0))}
                    </p>
                  </div>
                </div>
              )}

              {/* Top Gainers */}
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-slate-300">Top Gainers</h4>
                <div className="mt-3 grid gap-2">
                  {formattedGainers.slice(0, 5).map(g => (
                    <div key={g.symbol} className="flex items-center justify-between rounded-xl border border-white/5 bg-ink-800/60 px-3 py-2 text-xs">
                      <span className="text-slate-400">{g.symbol}</span>
                      <span className="font-semibold text-emerald-300">+{fmt(g.percent)}%</span>
                    </div>
                  ))}
                  {formattedGainers.length === 0 && <p className="text-xs text-slate-500">No data.</p>}
                </div>
              </div>
            </div>
          </section>

          {/* System Status */}
          <section className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.45s" }}>
            <h3 className="text-lg font-semibold">System Status</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              <StatusBlock label="Active Traders" value={status.activeTraders} />
              <StatusBlock label="Max Traders" value={status.maxTraders} />
              <StatusBlock label="Open Positions" value={totalOpen} />
              <StatusBlock label="API Status" value={mktStatus.api} capitalize />
              <StatusBlock label="Binance WS" value={mktStatus.ws} capitalize />
              <StatusBlock label="Dashboard Socket" value={sockStatus} capitalize />
            </div>
          </section>
        </main>
      </div>

      {/* ==================== DETAIL MODAL ==================== */}
      {detailTrader && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4 py-10">
          <div className="glass h-full w-full max-w-3xl overflow-y-auto rounded-3xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Trader Detail</p>
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-semibold">{detailTrader.symbol}</h3>
                  <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-cyan-300">
                    Perpetual
                  </span>
                  {detailTrader.leverage && (
                    <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-bold text-sky-300">
                      {detailTrader.leverage}x
                    </span>
                  )}
                </div>
              </div>
              <button
                className="rounded-full bg-white/10 px-3 py-1 text-sm text-slate-200"
                onClick={() => setDetailId(null)}
              >
                Close
              </button>
            </div>

            {/* Stats overview */}
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniStat label="Total Trades" value={detailTrader.totalTrades || 0} />
              <MiniStat label="Wins" value={detailTrader.wins || 0} valueClass="text-emerald-300" />
              <MiniStat label="Losses" value={detailTrader.losses || 0} valueClass="text-rose-300" />
              <MiniStat
                label="Win Rate"
                value={`${fmt(detailTrader.winRate || 0, 1)}%`}
                valueClass={(detailTrader.winRate || 0) >= 50 ? "text-emerald-300" : "text-rose-300"}
              />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniStat label="Notional" value={`$${fmt(detailTrader.notional)}`} />
              <MiniStat label="Leverage" value={`${detailTrader.leverage || "-"}x`} />
              {(() => {
                const s = streakText(detailTrader.currentStreak);
                return <MiniStat label="Current Streak" value={s.label} valueClass={s.className} />;
              })()}
              <MiniStat label="Same Dir Run" value={detailTrader.consecutiveSameDir || 0} valueClass="text-cyan-300" />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniStat label="Best Win Streak" value={detailTrader.longestWinStreak || 0} valueClass="text-emerald-300" />
              <MiniStat label="Worst Loss Streak" value={detailTrader.longestLossStreak || 0} valueClass="text-rose-300" />
              <MiniStat label="Base Notional" value={`$${fmt(detailTrader.baseNotional)}`} />
              <MiniStat label="Created" value={new Date(detailTrader.createdAt).toLocaleTimeString()} />
            </div>

            {/* Current position */}
            {detailTrader.position && detailTrader.position.direction && (
              <div className="mt-4 rounded-2xl border border-white/5 bg-ink-800/60 p-4">
                <h4 className="text-sm font-semibold text-slate-300">Current Position</h4>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                  <div>
                    <p className="text-xs text-slate-500">Direction</p>
                    <p className={`font-bold ${dirColor(detailTrader.position.direction)}`}>{detailTrader.position.direction}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Entry</p>
                    <p className="text-slate-200">{fmtPrice(detailTrader.position.entryPrice)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Take Profit</p>
                    <p className="text-emerald-300">{fmtPrice(detailTrader.position.tpPrice)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Stop Loss</p>
                    <p className="text-rose-300">{fmtPrice(detailTrader.position.slPrice)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Trade #</p>
                    <p className="text-slate-200">{detailTrader.position.tradeNumber}</p>
                  </div>
                </div>
              </div>
            )}

            {/* PnL Summary */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="Realized" value={`$${fmt(detailTrader.realizedPnl, 4)}`} valueClass={pnlColor(detailTrader.realizedPnl)} />
              <MiniStat label="Unrealized" value={`$${fmt(detailTrader.unrealizedPnl, 4)}`} valueClass={pnlColor(detailTrader.unrealizedPnl)} />
              <MiniStat label="Fees" value={`$${fmt(detailTrader.feesPaid, 4)}`} valueClass="text-orange-300" />
              <MiniStat
                label="Net"
                value={`$${fmt(Number(detailTrader.realizedPnl || 0) + Number(detailTrader.unrealizedPnl || 0), 4)}`}
                valueClass={pnlColor(Number(detailTrader.realizedPnl || 0) + Number(detailTrader.unrealizedPnl || 0))}
              />
            </div>

            {/* Trade History */}
            <div className="mt-6">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-300">Trade History</h4>
                <span className="text-xs text-slate-500">{(detailTrader.tradeHistory || []).length} trades</span>
              </div>
              <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                {(detailTrader.tradeHistory || []).slice().reverse().map((trade, idx) => (
                  <div key={`${trade.tradeNumber}-${idx}`} className="rounded-2xl bg-ink-800/70 px-4 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold border ${dirBg(trade.direction)}`}>
                          {trade.direction}
                        </span>
                        <span className={`text-xs font-semibold ${trade.reason === "take-profit" ? "text-emerald-400" : trade.reason === "stop-loss" ? "text-rose-400" : "text-slate-400"}`}>
                          {trade.reason}
                        </span>
                        <span className="text-xs text-slate-500">#{trade.tradeNumber}</span>
                      </div>
                      <span className={pnlColor(trade.netPnl)}>${fmt(trade.netPnl, 4)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                      <span>Entry {fmtPrice(trade.entry)}</span>
                      <span>Exit {fmtPrice(trade.exit)}</span>
                      {trade.fees != null && <span>Fee ${fmt(trade.fees, 4)}</span>}
                      {trade.grossPnl != null && <span>Gross ${fmt(trade.grossPnl, 4)}</span>}
                    </div>
                  </div>
                ))}
                {(detailTrader.tradeHistory || []).length === 0 && (
                  <p className="text-xs text-slate-500">No trades yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==================== Sub-components ==================== */

function SidebarCard({ label, value, className = "" }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-ink-800/70 px-4 py-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-lg font-semibold ${className}`}>{value}</p>
    </div>
  );
}

function StatusRow({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] uppercase text-slate-200">{value}</span>
    </div>
  );
}

function Pill({ children }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">
      {children}
    </span>
  );
}

function KpiCard({ delay, label, value, valueClass = "", sub }) {
  return (
    <div className="glass animate-fade-up rounded-3xl p-5" style={{ animationDelay: delay }}>
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</p>
      <p className="mt-2 text-xs text-slate-400">{sub}</p>
    </div>
  );
}

function StatusBlock({ label, value, capitalize }) {
  return (
    <div className="rounded-2xl bg-ink-800/70 p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-xl font-semibold ${capitalize ? "capitalize" : ""}`}>{value}</p>
    </div>
  );
}

function MiniStat({ label, value, valueClass = "" }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-ink-800/70 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

export default App;
