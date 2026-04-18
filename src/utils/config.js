const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 1,
  feeRate: 0.0004,
  fixedNotional: 500,
  equityFraction: 0.9,
  leverage: 10,
  takeProfitPercent: 1,
  stopLossPercent: 1,
  ladderLevels: 10,
  ladderGapPercent: 1,
  startingBalanceUSDT: 500,
  scannerIntervalMs: 1 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  lossCooldownMs: 3 * 60 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
