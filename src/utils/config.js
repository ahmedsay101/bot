const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 3,
  feeRate: 0.0004,
  fixedNotional: 50,
  leverage: 5,
  gridLevels: 5,
  gapPercent: 2,
  takeProfitPercent: 3,
  maxLifetimeMs: 4 * 60 * 60 * 1000,
  startingBalanceUSDT: 200,
  scannerIntervalMs: 1 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
