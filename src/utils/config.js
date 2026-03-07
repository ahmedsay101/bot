const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 1,
  feeRate: 0.0004,
  slippageRate: 0.0002,
  equityFraction: 0.10,
  leverage: 2,
  levelSpacingPercent: 1,
  maxOpenTransactions: 20,
  levelWindow: 5,
  destroyPercent: 20,
  startingBalanceUSDT: 200,
  scannerIntervalMs: 1 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
