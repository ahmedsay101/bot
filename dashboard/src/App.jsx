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

/* ------------------------------------------------------------------ */

function App() {
  const [status, setStatus] = useState({
    mode: "TEST", balance: 0, equity: 0, pnlToday: 0,
    activeTraders: 0, maxTraders: 0, roundStats: null
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
  const roundStats = status.roundStats || { totalTraders: 0, totalWins: 0, totalLosses: 0, winsByRound: {} };
  const roundChartData = useMemo(() => {
    const entries = Object.entries(roundStats.winsByRound || {});
    return entries
      .map(([round, count]) => ({ round: `R${round}`, wins: count }))
      .sort((a, b) => Number(a.round.slice(1)) - Number(b.round.slice(1)));
  }, [roundStats.winsByRound]);

  const winLossData = [
    { name: "Wins", value: perf.winRate || 0 },
    { name: "Losses", value: Math.max(0, 100 - (perf.winRate || 0)) }
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
              <h1 className="text-xl font-semibold">Martingale Bot</h1>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-slate-300">v2.0</span>
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
            <p className="text-lg font-semibold text-violet-300">MARTINGALE</p>
          </div>
        </aside>

        {/* ==================== MAIN ==================== */}
        <main className="flex flex-col gap-6">

          {/* Header */}
          <header className="glass animate-fade-up flex flex-wrap items-center justify-between gap-4 rounded-3xl px-6 py-5">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Operations Dashboard</p>
              <h2 className="text-2xl font-semibold">Binance Futures Martingale</h2>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Pill>Balance ${fmt(status.balance)}</Pill>
              <Pill>Active {traders.length}/{status.maxTraders}</Pill>
              <Pill>Open {totalOpen}</Pill>
            </div>
          </header>

          {/* KPI Cards */}
          <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard delay="0.05s" label="Win Rate" value={`${fmt(perf.winRate)}%`} sub={`Total Trades ${perf.totalTrades}`} />
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
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={winLossData} dataKey="value" innerRadius={50} outerRadius={90} paddingAngle={2}>
                      <Cell fill="#34d399" />
                      <Cell fill="#f87171" />
                    </Pie>
                    <Tooltip contentStyle={{ background: "#0c0f14", border: "1px solid #1f2838" }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-center text-xs text-slate-400">Win rate: {fmt(perf.winRate)}%</p>
            </div>
          </section>

          {/* Active Traders + Round Stats */}
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
                  const roundPct = t.maxRounds ? Math.round((t.currentRound / t.maxRounds) * 100) : 0;
                  const netPnl = Number(t.realizedPnl || 0) + Number(t.unrealizedPnl || 0);

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
                          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-300">
                            Martingale
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

                      {/* Round progress */}
                      <div className="mt-3 rounded-2xl bg-ink-900/70 px-4 py-3">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-400">Round</span>
                          <span className="font-semibold text-slate-200">
                            {t.currentRound || 1} / {t.maxRounds || "-"}
                          </span>
                        </div>
                        <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-900/70">
                          <div
                            className={`h-full rounded-full transition-all ${roundPct > 60 ? "bg-rose-400" : roundPct > 30 ? "bg-amber-400" : "bg-emerald-400"}`}
                            style={{ width: `${Math.max(roundPct, 4)}%` }}
                          />
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                          <span>Notional ${fmt(t.currentNotional)}</span>
                          <span>Base ${fmt(t.baseNotional)}</span>
                        </div>
                      </div>

                      {/* Position info */}
                      {pos && pos.direction && (
                        <div className="mt-3 rounded-2xl bg-ink-900/70 px-4 py-3">
                          <div className="flex items-center justify-between text-sm">
                            <span className={`font-bold ${dirColor(pos.direction)}`}>{pos.direction}</span>
                            <span className="text-slate-400">Entry {fmtPrice(pos.entry)}</span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                            <div className="flex items-center justify-between rounded-xl bg-emerald-500/10 px-3 py-1.5">
                              <span className="text-emerald-400">TP</span>
                              <span className="text-emerald-300">{fmtPrice(pos.tp)}</span>
                            </div>
                            <div className="flex items-center justify-between rounded-xl bg-rose-500/10 px-3 py-1.5">
                              <span className="text-rose-400">SL</span>
                              <span className="text-rose-300">{fmtPrice(pos.sl)}</span>
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

            {/* Round Statistics */}
            <div className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.4s" }}>
              <h3 className="text-lg font-semibold">Round Statistics</h3>

              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-2xl bg-ink-800/70 p-3">
                  <p className="text-xs text-slate-400">Total</p>
                  <p className="text-xl font-semibold">{roundStats.totalTraders}</p>
                </div>
                <div className="rounded-2xl bg-ink-800/70 p-3">
                  <p className="text-xs text-emerald-400">Wins</p>
                  <p className="text-xl font-semibold text-emerald-300">{roundStats.totalWins}</p>
                </div>
                <div className="rounded-2xl bg-ink-800/70 p-3">
                  <p className="text-xs text-rose-400">Losses</p>
                  <p className="text-xl font-semibold text-rose-300">{roundStats.totalLosses}</p>
                </div>
              </div>

              {/* Wins by round table */}
              <div className="mt-4 space-y-2">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Wins by Round</p>
                {Object.keys(roundStats.winsByRound || {}).length > 0 ? (
                  <div className="rounded-2xl border border-white/5 bg-ink-800/60 overflow-hidden">
                    {Object.entries(roundStats.winsByRound)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([round, count]) => {
                        const pct = roundStats.totalWins > 0 ? ((count / roundStats.totalWins) * 100) : 0;
                        return (
                          <div key={round} className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 last:border-0">
                            <span className="text-sm text-slate-300">Round {round}</span>
                            <div className="flex items-center gap-3">
                              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-900/70">
                                <div className="h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="w-8 text-right text-sm font-semibold text-emerald-300">{count}</span>
                              <span className="w-12 text-right text-xs text-slate-400">{fmt(pct, 1)}%</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">No round data yet.</p>
                )}
              </div>

              {/* Bar chart */}
              {roundChartData.length > 0 && (
                <div className="mt-4 h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={roundChartData}>
                      <XAxis dataKey="round" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                      <YAxis hide />
                      <Tooltip contentStyle={{ background: "#0c0f14", border: "1px solid #1f2838" }} />
                      <Bar dataKey="wins" fill="#34d399" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
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

            {/* Round info */}
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniStat label="Round" value={`${detailTrader.currentRound || 1} / ${detailTrader.maxRounds || "-"}`} />
              <MiniStat label="Notional" value={`$${fmt(detailTrader.currentNotional)}`} />
              <MiniStat label="Base" value={`$${fmt(detailTrader.baseNotional)}`} />
              <MiniStat label="Leverage" value={`${detailTrader.leverage || "-"}x`} />
            </div>

            {/* Current position */}
            {detailTrader.position && detailTrader.position.direction && (
              <div className="mt-4 rounded-2xl border border-white/5 bg-ink-800/60 p-4">
                <h4 className="text-sm font-semibold text-slate-300">Current Position</h4>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-slate-500">Direction</p>
                    <p className={`font-bold ${dirColor(detailTrader.position.direction)}`}>{detailTrader.position.direction}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Entry</p>
                    <p className="text-slate-200">{fmtPrice(detailTrader.position.entry)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Take Profit</p>
                    <p className="text-emerald-300">{fmtPrice(detailTrader.position.tp)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Stop Loss</p>
                    <p className="text-rose-300">{fmtPrice(detailTrader.position.sl)}</p>
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
              <h4 className="text-sm font-semibold text-slate-300">Trade History</h4>
              <div className="mt-2 space-y-2">
                {(detailTrader.tradeHistory || []).map((trade, idx) => (
                  <div key={`${trade.reason}-${idx}`} className="rounded-2xl bg-ink-800/70 px-4 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold border ${dirBg(trade.direction || trade.side)}`}>
                          {trade.direction || trade.side || "-"}
                        </span>
                        <span className="text-slate-300">{trade.reason}</span>
                        {trade.round != null && (
                          <span className="text-xs text-slate-500">R{trade.round}</span>
                        )}
                      </div>
                      <span className={pnlColor(trade.pnl)}>${fmt(trade.pnl, 4)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                      <span>Entry {fmtPrice(trade.entry)}</span>
                      <span>Exit {fmtPrice(trade.exit)}</span>
                      {trade.fees != null && <span>Fee ${fmt(trade.fees, 4)}</span>}
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
