const config = require("../utils/config");

const state = {
  mode: config.mode.toUpperCase(),
  balance: config.startingBalanceUSDT,
  equity: config.startingBalanceUSDT,
  pnlToday: 0,
  activeTraders: new Map(),
  closedTraders: [],
  performance: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    netProfit: 0,
    feesPaid: 0,
    maxDrawdown: 0
  },
  equityHistory: [],
  peakEquity: config.startingBalanceUSDT,
  marketStatus: {
    api: "unknown",
    ws: "unknown",
    updatedAt: null
  }
};

function setMarketStatus(patch) {
  state.marketStatus = {
    ...state.marketStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  };
}

function setBalance(balance) {
  state.balance = Number(balance);
}

function setEquity(equity) {
  const value = Number(equity);
  state.equity = value;
  if (value > state.peakEquity) state.peakEquity = value;
  const drawdown = state.peakEquity === 0
    ? 0
    : ((state.peakEquity - value) / state.peakEquity) * 100;
  if (drawdown > state.performance.maxDrawdown) state.performance.maxDrawdown = drawdown;

  state.equityHistory.push({ time: Date.now(), equity: value });
  if (state.equityHistory.length > 500) state.equityHistory.shift();
}

function upsertTrader(trader) {
  const prev = state.activeTraders.get(trader.id) || {};
  state.activeTraders.set(trader.id, { ...prev, ...trader });
}

function removeTrader(id, summary) {
  if (state.activeTraders.has(id)) state.activeTraders.delete(id);
  if (summary) {
    state.closedTraders.unshift(summary);
    if (state.closedTraders.length > 50) state.closedTraders.pop();
  }
}

function recordTrade({ pnl, fees }) {
  const gross = Number(pnl) || 0;
  const fee = Number(fees) || 0;

  state.performance.totalTrades += 1;
  if (gross >= 0) {
    state.performance.wins += 1;
    state.performance.grossProfit += gross;
  } else {
    state.performance.losses += 1;
    state.performance.grossLoss += Math.abs(gross);
  }

  state.performance.feesPaid += fee;
  state.performance.netProfit =
    state.performance.grossProfit - state.performance.grossLoss - state.performance.feesPaid;

  state.pnlToday += gross - fee;
}

function getStatus() {
  return {
    mode: state.mode,
    balance: state.balance,
    equity: state.equity,
    pnlToday: state.pnlToday,
    activeTraders: state.activeTraders.size,
    maxTraders: config.maxTraders,
    marketStatus: state.marketStatus
  };
}

function getTraders() {
  return Array.from(state.activeTraders.values());
}

function getTrader(id) {
  return state.activeTraders.get(id) || null;
}

function getHistory() {
  return state.closedTraders;
}

function getPerformance() {
  const unrealized = getTraders().reduce(
    (sum, trader) => sum + Number(trader.unrealizedPnl || 0),
    0
  );
  const winRate = state.performance.totalTrades === 0
    ? 0
    : (state.performance.wins / state.performance.totalTrades) * 100;

  const grossProfitLive = state.performance.grossProfit + Math.max(0, unrealized);
  const grossLossLive = state.performance.grossLoss + Math.max(0, -unrealized);
  const netProfitLive = grossProfitLive - grossLossLive - state.performance.feesPaid;

  return {
    totalTrades: state.performance.totalTrades,
    winRate,
    grossProfit: state.performance.grossProfit,
    grossLoss: state.performance.grossLoss,
    netProfit: state.performance.netProfit,
    feesPaid: state.performance.feesPaid,
    maxDrawdown: state.performance.maxDrawdown,
    unrealizedPnl: unrealized,
    grossProfitLive,
    grossLossLive,
    netProfitLive
  };
}

function getDashboardUpdate() {
  return {
    status: getStatus(),
    balance: state.balance,
    traders: getTraders().map((trader) => ({
      ...trader
    })),
    performance: getPerformance(),
    marketStatus: state.marketStatus
  };
}

module.exports = {
  setMarketStatus,
  setBalance,
  setEquity,
  upsertTrader,
  removeTrader,
  recordTrade,
  getStatus,
  getTraders,
  getTrader,
  getHistory,
  getPerformance,
  getDashboardUpdate
};
