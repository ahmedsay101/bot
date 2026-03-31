const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 1,
  feeRate: 0.0004,
  equityFraction: 0.9,
  leverage: 2,
  notionalPerOrder: 50,
  takeProfitPercent: 10,
  stopLossPercent: 50,
  minPctRequired: 50,
  startingBalanceUSDT: 200,
  scannerIntervalMs: 1 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
