import { useEffect, useMemo, useRef, useState } from "react";
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
  Cell
} from "recharts";

const API_URL = import.meta.env.VITE_API_URL || "";

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const fixed = Number(value).toFixed(digits);
  return fixed.replace(/\.0+$/, "");
}

function formatPrice(value) {
  const num = Number(value);
  if (value === null || value === undefined || Number.isNaN(num)) return "-";
  if (Math.abs(num) >= 1) return num.toFixed(4);
  if (Math.abs(num) >= 0.01) return num.toFixed(6);
  return num.toFixed(8);
}

function calcPercentChange(start, current) {
  const base = Number(start);
  const last = Number(current);
  if (!Number.isFinite(base) || !Number.isFinite(last) || base === 0) return null;
  return ((last - base) / base) * 100;
}

function findNearestLevel(levels, price) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let best = levels[0];
  let bestDiff = Math.abs(Number(levels[0].price) - price);
  for (let i = 1; i < levels.length; i += 1) {
    const diff = Math.abs(Number(levels[i].price) - price);
    if (diff < bestDiff) {
      best = levels[i];
      bestDiff = diff;
    }
  }
  return best;
}

function sliceLevelWindow(levels, price, range = 5) {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a.index - b.index);
  const nearest = findNearestLevel(sorted, price);
  if (!nearest) return sorted.slice(0, range * 2 + 1);
  const centerIndex = sorted.findIndex((level) => level.index === nearest.index);
  const start = Math.max(0, centerIndex - range);
  const end = Math.min(sorted.length, centerIndex + range + 1);
  return sorted.slice(start, end);
}

function calcPositionPnl(position, lastPrice) {
  if (!position || !lastPrice) return null;
  const entry = Number(position.entryPrice);
  const size = Number(position.size);
  if (!entry || !size) return null;
  const direction = position.side === "LONG" ? 1 : -1;
  return (Number(lastPrice) - entry) * size * direction;
}

function calcTakeProfitProgress(position, lastPrice) {
  if (!position || lastPrice === null || lastPrice === undefined) return null;
  const entry = Number(position.entryPrice);
  const tp = Number(position.takeProfitPrice);
  const current = Number(lastPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(current)) return null;
  const direction = position.side === "LONG" ? 1 : -1;
  const total = direction === 1 ? tp - entry : entry - tp;
  if (!Number.isFinite(total) || total === 0) return null;
  const traveled = direction === 1 ? current - entry : entry - current;
  const ratio = Math.max(0, Math.min(1, traveled / total));
  const remaining = Math.max(0, Math.abs(tp - current));
  return { ratio, remaining };
}

function buildPendingTakeProfit(order, takeProfitPercent) {
  const entry = Number(order.price);
  const tpPct = Number(takeProfitPercent) || 0;
  if (!Number.isFinite(entry) || tpPct <= 0) return null;
  const side = order.side;
  const tpPrice = side === "LONG"
    ? entry * (1 + tpPct / 100)
    : entry * (1 - tpPct / 100);
  return {
    entryPrice: entry,
    takeProfitPrice: tpPrice,
    side,
    levelIndex: order.levelIndex,
    pending: true
  };
}

function buildPriceLines(trader) {
  const lines = [];
  const lastPrice = Number(trader.lastPrice) || 0;
  const basePrice = Number(trader.basePrice) || 0;
  const usePercent = basePrice > 0;
  const toValue = (price) => (usePercent ? ((price / basePrice) - 1) * 100 : price);

  if (lastPrice) {
    lines.push({
      key: `${trader.id}-current`,
      price: lastPrice,
      value: toValue(lastPrice),
      label: "Current",
      tone: "current",
      opacity: 1
    });
  }

  const levels = sliceLevelWindow(trader.gridLevels?.levels || [], lastPrice, 5);
  levels.forEach((level) => {
    const isPending = String(level.status || "").startsWith("PENDING");
    const tone = level.status === "LONG" || level.status === "PENDING_LONG"
      ? "long"
      : level.status === "SHORT" || level.status === "PENDING_SHORT"
        ? "short"
        : "empty";
    lines.push({
      key: `${trader.id}-level-${level.index}`,
      price: Number(level.price),
      value: toValue(Number(level.price)),
      label: `L${level.index}`,
      tone,
      opacity: level.status === "EMPTY" || isPending ? 0.35 : 0.9
    });
  });

  const referenceLines = lines.filter((line) => line.tone !== "current");
  const values = (referenceLines.length ? referenceLines : lines)
    .map((line) => line.value)
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return { lines: [], min: 0, max: 0 };

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= min * 0.2 || 1;
    max += max * 0.2 || 1;
  } else {
    const padding = (max - min) * 0.12;
    min -= padding;
    max += padding;
  }

  return { lines, min, max, paddingPct: 16, usePercent };
}

function positionLadderLines(ladder) {
  const paddingPct = ladder.paddingPct || 0;
  const levelLines = ladder.lines.filter((line) => line.tone !== "current");
  const currentLine = ladder.lines.find((line) => line.tone === "current") || null;

  if (levelLines.length === 0 && currentLine) {
    return [{ ...currentLine, top: 50 }];
  }

  const sortedLevels = [...levelLines].sort((a, b) => b.value - a.value);
  const slots = sortedLevels.length;
  const topMin = paddingPct;
  const topMax = 100 - paddingPct;
  const step = slots > 1 ? (topMax - topMin) / (slots - 1) : 0;

  const positionedLevels = sortedLevels.map((line, index) => ({
    ...line,
    top: slots > 1 ? topMin + step * index : 50
  }));

  if (!currentLine) return positionedLevels;

  const values = positionedLevels.map((line) => line.value);
  const tops = positionedLevels.map((line) => line.top);
  const currentValue = currentLine.value;

  let currentTop = 50;
  if (values.length === 1) {
    currentTop = tops[0];
  } else {
    let lowerIndex = values.length - 1;
    let upperIndex = 0;

    for (let i = 0; i < values.length; i += 1) {
      if (values[i] >= currentValue) upperIndex = i;
      if (values[i] <= currentValue) {
        lowerIndex = i;
        break;
      }
    }

    if (upperIndex === lowerIndex) {
      currentTop = tops[upperIndex];
    } else {
      const upperValue = values[upperIndex];
      const lowerValue = values[lowerIndex];
      const upperTop = tops[upperIndex];
      const lowerTop = tops[lowerIndex];
      const span = upperValue - lowerValue || 1;
      const ratio = (upperValue - currentValue) / span;
      currentTop = upperTop + (lowerTop - upperTop) * ratio;
    }
  }

  const clampedTop = Math.min(topMax, Math.max(topMin, currentTop));
  return [...positionedLevels, { ...currentLine, top: clampedTop }];
}

function App() {
  const [status, setStatus] = useState({
    mode: "TEST",
    balance: 0,
    equity: 0,
    pnlToday: 0,
    activeTraders: 0,
    maxTraders: 0
  });
  const [traders, setTraders] = useState([]);
  const [performance, setPerformance] = useState({
    totalTrades: 0,
    winRate: 0,
    grossProfit: 0,
    grossLoss: 0,
    netProfit: 0,
    feesPaid: 0,
    maxDrawdown: 0,
    unrealizedPnl: 0,
    grossProfitLive: 0,
    grossLossLive: 0,
    netProfitLive: 0
  });
  const [marketStatus, setMarketStatus] = useState({ api: "unknown", ws: "unknown" });
  const [socketStatus, setSocketStatus] = useState("disconnected");
  const [equitySeries, setEquitySeries] = useState([]);
  const [selectedTraderId, setSelectedTraderId] = useState(null);
  const [selectedTrader, setSelectedTrader] = useState(null);
  const [topGainers, setTopGainers] = useState([]);
  const ladderRef = useRef(null);

  const equityData = useMemo(() => equitySeries.slice(-120), [equitySeries]);

  useEffect(() => {
    async function loadInitial() {
      const [statusRes, tradersRes, perfRes] = await Promise.all([
        axios.get(`${API_URL}/api/status`),
        axios.get(`${API_URL}/api/traders`),
        axios.get(`${API_URL}/api/performance`)
      ]);

      setStatus(statusRes.data);
      if (statusRes.data.marketStatus) setMarketStatus(statusRes.data.marketStatus);
      setTraders(tradersRes.data);
      setPerformance((prev) => ({
        ...prev,
        ...(perfRes.data || {})
      }));
    }

    loadInitial().catch(() => {
      setSocketStatus("error");
    });
  }, []);

  useEffect(() => {
    async function loadTopGainers() {
      try {
        const res = await axios.get(`${API_URL}/api/top-gainers`);
        setTopGainers(res.data || []);
      } catch {
        setTopGainers([]);
      }
    }

    loadTopGainers();
  }, []);

  useEffect(() => {
    const socket = io(API_URL, { path: "/api/socket.io", transports: ["websocket"] });

    socket.on("connect", () => setSocketStatus("connected"));
    socket.on("disconnect", () => setSocketStatus("disconnected"));

    socket.on("dashboardUpdate", (payload) => {
      const nextTraders = payload.traders || [];
      const nextBalance = Number(payload.balance || 0);
      const unrealized = nextTraders.reduce(
        (sum, trader) => sum + Number(trader.unrealizedPnl || 0),
        0
      );
      const nextEquity = nextBalance + unrealized;

      setTraders(nextTraders);
      setPerformance((prev) => ({
        ...prev,
        ...(payload.performance || {})
      }));
      setMarketStatus((prev) => payload.marketStatus || prev);
      if (payload.topGainers) setTopGainers(payload.topGainers);
      setStatus((prev) => ({
        ...prev,
        ...(payload.status || {}),
        balance: nextBalance,
        equity: nextEquity
      }));

      setEquitySeries((prev) => {
        const next = [...prev, { time: new Date().toLocaleTimeString(), equity: nextEquity }];
        return next.slice(-200);
      });
    });

    socket.on("priceUpdate", (payload) => {
      const symbol = payload?.symbol;
      const price = Number(payload?.price);
      if (!symbol || !Number.isFinite(price)) return;

      setTraders((prev) => prev.map((trader) => (
        trader.symbol === symbol ? { ...trader, lastPrice: price } : trader
      )));
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedTraderId) {
      setSelectedTrader(null);
      return;
    }

    axios
      .get(`${API_URL}/api/traders/${selectedTraderId}`)
      .then((res) => setSelectedTrader(res.data))
      .catch(() => setSelectedTrader(null));
  }, [selectedTraderId]);

  useEffect(() => {
    if (!selectedTrader) return;
    const container = ladderRef.current;
    if (!container) return;
    const active = container.querySelector("[data-current='true']");
    if (active) active.scrollIntoView({ block: "center" });
  }, [selectedTrader]);

  const winLossData = [
    { name: "Wins", value: performance.winRate },
    { name: "Losses", value: Math.max(0, 100 - performance.winRate) }
  ];

  const formattedTopGainers = (Array.isArray(topGainers) ? topGainers : []).map((gainer) => ({
    symbol: gainer.symbol,
    percent: Number(gainer.percent) || 0
  }));

  const totalOpenPositions = traders.reduce(
    (sum, trader) => sum + Number(trader.openPositions || 0),
    0
  );
  const selectedOpenPositions = selectedTrader?.openPositions ?? [];
  const selectedTradeHistory = selectedTrader?.tradeHistory ?? [];

  return (
    <div className="min-h-screen grid-bg text-slate-100">
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-6 pb-16 pt-8 lg:grid-cols-[260px_1fr]">
        <aside className="glass animate-fade-up sticky top-6 h-fit rounded-3xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Command</p>
              <h1 className="text-xl font-semibold">Volatility Trap</h1>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-slate-300">
              v1.0
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-white/5 bg-ink-800/70 px-4 py-3">
              <p className="text-xs text-slate-400">Mode</p>
              <p className={`text-lg font-semibold ${status.mode === "LIVE" ? "text-emerald-300" : "text-amber-300"}`}>
                {status.mode}
              </p>
            </div>
            <div className="rounded-2xl border border-white/5 bg-ink-800/70 px-4 py-3">
              <p className="text-xs text-slate-400">Equity</p>
              <p className="text-lg font-semibold">${formatNumber(status.equity)}</p>
            </div>
            <div className="rounded-2xl border border-white/5 bg-ink-800/70 px-4 py-3">
              <p className="text-xs text-slate-400">Today PnL</p>
              <p className={`text-lg font-semibold ${status.pnlToday >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                ${formatNumber(status.pnlToday)}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3 text-xs text-slate-400">
            <div className="flex items-center justify-between">
              <span>API Status</span>
              <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] uppercase text-slate-200">
                {marketStatus.api}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Socket</span>
              <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] uppercase text-slate-200">
                {socketStatus}
              </span>
            </div>
          </div>
        </aside>

        <main className="flex flex-col gap-6">
          <header className="glass animate-fade-up flex flex-wrap items-center justify-between gap-4 rounded-3xl px-6 py-5">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Operations Dashboard</p>
              <h2 className="text-2xl font-semibold">Binance Futures Command Center</h2>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">
                Balance ${formatNumber(status.balance)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">
                Active {traders.length}/{status.maxTraders}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">
                Open {totalOpenPositions}
              </span>
            </div>
          </header>

          <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <div className="glass animate-fade-up rounded-3xl p-5" style={{ animationDelay: "0.05s" }}>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Win Rate</p>
              <p className="mt-2 text-2xl font-semibold">{formatNumber(performance.winRate)}%</p>
              <p className="mt-2 text-xs text-slate-400">Total Trades {performance.totalTrades}</p>
            </div>
            <div className="glass animate-fade-up rounded-3xl p-5" style={{ animationDelay: "0.1s" }}>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Net Profit</p>
              <p className={`mt-2 text-2xl font-semibold ${performance.netProfitLive >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                ${formatNumber(performance.netProfitLive)}
              </p>
              <p className="mt-2 text-xs text-slate-400">Live incl. unrealized</p>
            </div>
            <div className="glass animate-fade-up rounded-3xl p-5" style={{ animationDelay: "0.15s" }}>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Gross Profit</p>
              <p className="mt-2 text-2xl font-semibold text-emerald-300">${formatNumber(performance.grossProfitLive)}</p>
              <p className="mt-2 text-xs text-slate-400">Gross Loss ${formatNumber(performance.grossLossLive)}</p>
            </div>
            <div className="glass animate-fade-up rounded-3xl p-5" style={{ animationDelay: "0.2s" }}>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Max Drawdown</p>
              <p className="mt-2 text-2xl font-semibold text-amber-300">{formatNumber(performance.maxDrawdown)}%</p>
              <p className="mt-2 text-xs text-slate-400">Balance ${formatNumber(status.balance)}</p>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-3">
            <div className="glass animate-fade-up rounded-3xl p-6 xl:col-span-2" style={{ animationDelay: "0.25s" }}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Equity Curve</h3>
                <span className="text-xs text-slate-400">Last 120 ticks</span>
              </div>
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={equityData}>
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
              <p className="mt-2 text-xs text-slate-400">Win rate: {formatNumber(performance.winRate)}%</p>
            </div>
          </section>

          <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.35s" }}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Active Traders</h3>
                <span className="text-sm text-slate-400">
                  {traders.length} / {status.maxTraders} active
                </span>
              </div>
              <div className="mt-4 grid gap-4">
                {traders.map((trader) => (
                  <button
                    key={trader.id}
                    type="button"
                    className="relative overflow-visible rounded-2xl border border-white/5 bg-ink-800/60 p-4 text-left transition hover:bg-ink-800/80"
                    onClick={() => setSelectedTraderId(trader.id)}
                  >
                    {(() => {
                      const ladder = buildPriceLines(trader);
                      const positioned = positionLadderLines(ladder);
                      const ladderHeight = 180;
                      return (
                        <div className="price-ladder" style={{ height: `${ladderHeight}px` }}>
                          {positioned.map((line) => {
                            return (
                              <div
                                key={line.key}
                                className={`price-line ${line.tone}`}
                                style={{ top: `${line.top}%`, opacity: line.opacity }}
                              >
                                <span className="price-line-label">{line.label}</span>
                                <span className="price-line-value">{formatPrice(line.price)}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{trader.status}</p>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] font-medium ${
                            trader.traderType === "VOLATILITY"
                              ? "bg-violet-500/20 text-violet-300 border border-violet-400/30"
                              : "bg-sky-500/20 text-sky-300 border border-sky-400/30"
                          }`}>
                            {trader.traderType === "VOLATILITY" ? "Volatility" : "Expansion"}
                          </span>
                        </div>
                        <h4 className="text-lg font-semibold text-slate-100">{trader.symbol}</h4>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                          Open {trader.openPositions}
                        </span>
                        <span
                          className={`rounded-full border border-white/10 bg-white/5 px-3 py-1 ${
                            trader.unrealizedPnl >= 0 ? "text-emerald-300" : "text-rose-300"
                          }`}
                        >
                          Unrealized ${formatNumber(trader.unrealizedPnl)}
                        </span>
                        <span
                          className={`rounded-full border border-white/10 bg-white/5 px-3 py-1 ${
                            (Number(trader.realizedPnl || 0) + Number(trader.unrealizedPnl || 0)) >= 0
                              ? "text-emerald-300"
                              : "text-rose-300"
                          }`}
                        >
                          Net ${formatNumber(Number(trader.realizedPnl || 0) + Number(trader.unrealizedPnl || 0))}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-rose-300">
                          Total Loss ${formatNumber(
                            Math.max(0, -(Number(trader.realizedPnl || 0) + Number(trader.unrealizedPnl || 0)))
                          )}
                        </span>
                      </div>
                    </div>

                    {(() => {
                      const basePrice = trader.basePrice || trader.gridLevels?.basePrice;
                      const changePct = calcPercentChange(basePrice, trader.lastPrice);
                      const takeProfitPercent = Number(trader.gridLevels?.takeProfitPercent) || 0;
                      const positions = trader.openPositionsDetail || [];
                      const pendingOrders = trader.pendingOrdersDetail || [];
                      const pendingTargets = positions.length === 0
                        ? pendingOrders
                          .map((order) => buildPendingTakeProfit(order, takeProfitPercent))
                          .filter(Boolean)
                        : [];
                      const progressTargets = positions.length > 0 ? positions : pendingTargets;

                      return (
                        <div className="mt-4 grid gap-3">
                          <div className="rounded-2xl bg-ink-900/70 px-4 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                              <span className="text-slate-400">Start</span>
                              <span className="text-slate-200">{formatPrice(basePrice)}</span>
                              <span className="text-slate-400">Now</span>
                              <span className="text-slate-200">{formatPrice(trader.lastPrice)}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between text-xs">
                              <span className="text-slate-400">Change</span>
                              <span className={changePct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                                {changePct === null ? "-" : `${formatPercent(changePct, 2)}%`}
                              </span>
                            </div>
                          </div>

                          <div className="rounded-2xl bg-ink-900/70 px-4 py-3">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-slate-400">Take Profit</span>
                              <span className="text-slate-200">{formatPercent(takeProfitPercent, 2)}%</span>
                            </div>
                            <p className="mt-2 text-xs text-slate-500">
                              Per position, based on level spacing.
                            </p>
                          </div>

                          {progressTargets.length > 0 && (
                            <div className="rounded-2xl bg-ink-900/70 px-4 py-3">
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-slate-400">Take Profit Progress</span>
                                <span className="text-xs text-slate-500">
                                  {positions.length > 0 ? "Current vs TP" : "Pending entry vs TP"}
                                </span>
                              </div>
                              <div className="mt-3 grid gap-3">
                                {progressTargets.map((pos) => {
                                  const progress = calcTakeProfitProgress(pos, trader.lastPrice);
                                  const percent = progress ? Math.round(progress.ratio * 100) : null;
                                  const displayPercent = pos.pending
                                    ? null
                                    : (percent ?? 0);
                                  const barWidth = pos.pending
                                    ? 35
                                    : (displayPercent ?? 0);
                                  const remaining = progress ? progress.remaining : null;
                                  return (
                                    <div key={`${trader.id}-${pos.levelIndex}-${pos.side}`}>
                                      <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                                        <span>
                                          {pos.side} L{pos.levelIndex}
                                          {pos.pending ? " · pending" : ""}
                                        </span>
                                        <span>
                                          {displayPercent === null ? "-" : `${displayPercent}%`} ·
                                          {remaining === null ? " -" : ` ${formatPrice(remaining)} left`}
                                        </span>
                                      </div>
                                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-900/70">
                                        <div
                                          className={`h-full rounded-full ${pos.pending ? "bg-sky-400" : (pos.side === "LONG" ? "bg-emerald-400" : "bg-rose-400")}`}
                                          style={{ width: `${barWidth}%` }}
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </button>
                ))}
                {traders.length === 0 && (
                  <p className="py-6 text-center text-sm text-slate-500">No active traders yet.</p>
                )}
              </div>
            </div>

            <div className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.4s" }}>
              <h3 className="text-lg font-semibold">Top Gainers</h3>
              <div className="mt-4 grid gap-3">
                {formattedTopGainers.map((gainer) => (
                  <div key={gainer.symbol} className="rounded-2xl border border-white/5 bg-ink-800/60 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{gainer.symbol}</p>
                        <p className="text-sm text-slate-300">24h change</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold text-emerald-300">+{formatNumber(gainer.percent)}%</p>
                      </div>
                    </div>
                  </div>
                ))}
                {formattedTopGainers.length === 0 && (
                  <p className="text-sm text-slate-500">No gainers yet.</p>
                )}
              </div>
            </div>
          </section>

          <section className="glass animate-fade-up rounded-3xl p-6" style={{ animationDelay: "0.45s" }}>
            <h3 className="text-lg font-semibold">System Status</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
              <div className="rounded-2xl bg-ink-800/70 p-4">
                <p className="text-xs text-slate-400">Total Active Traders</p>
                <p className="text-xl font-semibold">{status.activeTraders}</p>
              </div>
              <div className="rounded-2xl bg-ink-800/70 p-4">
                <p className="text-xs text-slate-400">Max Traders</p>
                <p className="text-xl font-semibold">{status.maxTraders}</p>
              </div>
              <div className="rounded-2xl bg-ink-800/70 p-4">
                <p className="text-xs text-slate-400">Open Positions</p>
                <p className="text-xl font-semibold">{totalOpenPositions}</p>
              </div>
              <div className="rounded-2xl bg-ink-800/70 p-4">
                <p className="text-xs text-slate-400">API Status</p>
                <p className="text-xl font-semibold capitalize">{marketStatus.api}</p>
              </div>
              <div className="rounded-2xl bg-ink-800/70 p-4">
                <p className="text-xs text-slate-400">Binance WS</p>
                <p className="text-xl font-semibold capitalize">{marketStatus.ws}</p>
              </div>
              <div className="rounded-2xl bg-ink-800/70 p-4">
                <p className="text-xs text-slate-400">Dashboard Socket</p>
                <p className="text-xl font-semibold capitalize">{socketStatus}</p>
              </div>
            </div>
          </section>
        </main>
      </div>

      {selectedTrader && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 px-4 py-10">
          <div className="glass h-full w-full max-w-5xl overflow-y-auto rounded-3xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Trader Detail</p>
                <h3 className="text-xl font-semibold">{selectedTrader.symbol}</h3>
              </div>
              <button
                className="rounded-full bg-white/10 px-3 py-1 text-sm text-slate-200"
                onClick={() => setSelectedTraderId(null)}
              >
                Close
              </button>
            </div>

            <div className="mt-6 space-y-6">
              <div>
                <h4 className="text-sm font-semibold text-slate-300">Grid Ladder</h4>
                {(() => {
                  const levels = selectedTrader.gridLevels?.levels || [];
                  const currentPrice = Number(selectedTrader.lastPrice) || 0;
                  const sortedLevels = [...levels].sort((a, b) => b.price - a.price);
                  const nearest = findNearestLevel(sortedLevels, currentPrice);
                  return (
                    <div
                      ref={ladderRef}
                      className="mt-3 max-h-[520px] overflow-y-auto rounded-2xl border border-white/5 bg-ink-800/60"
                    >
                      {sortedLevels.map((level) => {
                        const isCurrent = nearest && nearest.index === level.index;
                        const tone = level.status === "LONG" || level.status === "PENDING_LONG"
                          ? "text-emerald-300"
                          : level.status === "SHORT" || level.status === "PENDING_SHORT"
                            ? "text-rose-300"
                            : "text-slate-400";
                        const opacityClass = level.status === "EMPTY" || String(level.status).startsWith("PENDING")
                          ? "opacity-50"
                          : "";
                        return (
                          <div
                            key={`level-${level.index}`}
                            data-current={isCurrent ? "true" : "false"}
                            className={`flex items-center justify-between border-b border-white/5 px-4 py-2 text-sm ${
                              isCurrent ? "bg-white/5" : ""
                            } ${opacityClass}`}
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-xs uppercase tracking-[0.2em] text-slate-500">L{level.index}</span>
                              <span className={tone}>{level.status}</span>
                            </div>
                            <div className="flex items-center gap-4 text-xs text-slate-400">
                              <span>Price {formatPrice(level.price)}</span>
                              <span>TP {level.takeProfitPrice ? formatPrice(level.takeProfitPrice) : "-"}</span>
                            </div>
                          </div>
                        );
                      })}
                      {levels.length === 0 && (
                        <p className="px-4 py-3 text-xs text-slate-500">No levels yet.</p>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div>
                <h4 className="text-sm font-semibold text-slate-300">Trade History</h4>
                <div className="mt-2 space-y-2">
                  {selectedTradeHistory.map((trade, idx) => (
                    <div key={`${trade.reason}-${idx}`} className="rounded-2xl bg-ink-800/70 px-4 py-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-slate-300">{trade.reason}</span>
                        <span className={trade.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                          {formatNumber(trade.pnl)}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Entry {formatNumber(trade.entry)} | Exit {formatNumber(trade.exit)}
                      </div>
                    </div>
                  ))}
                  {selectedTradeHistory.length === 0 && (
                    <p className="text-xs text-slate-500">No trades recorded.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
