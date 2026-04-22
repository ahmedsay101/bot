const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 1,
  feeRate: 0.0004,
  fixedNotional: 500,
  equityFraction: 0.8,
  leverage: 2,
  dynamicTp: false,
  takeProfitPercent: 5,
  stopLossPercent: 5,
  maxAccumulatedSlPercent: 15,
  minChangePercent: 60,
  minAvgTopGainerPercent: 70,
  startingBalanceUSDT: 500,
  scannerIntervalMs: 1 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  lossCooldownMs: 3 * 60 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
