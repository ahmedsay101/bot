const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 1,
  feeRate: 0.0004,
  equityFraction: 0.8,
  leverage: 2,
  takeProfitPercent: 5,        // single-trade TP %
  stopLossPercent: 1,          // single-trade SL %
  profitTargetPercent: 5,      // destroy trader when (accTp - accSl) >= this
  consecutiveSlFlipCount: 5,   // after this many consecutive SLs, flip to opposite side
  startingBalanceUSDT: 500,
  scannerIntervalMs: 1 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  recvWindow: 5000
};

module.exports = config;
