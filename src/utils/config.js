const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 3,
  feeRate: 0.0004,
  fixedNotional: 500,
  leverage: 10,
  gridLevels: 10,
  gapPercent: 1,
  takeProfitPercent: 3,
  maxLifetimeMs: 1 * 60 * 60 * 1000,
  startingBalanceUSDT: 1700,
  scannerIntervalMs: 1 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
