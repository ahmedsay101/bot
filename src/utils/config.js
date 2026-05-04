const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",

  maxTraders: 1,
  feeRate: 0.0004,
  equityFraction: 0.4,
  leverage: 4,
  startingBalanceUSDT: 300,

  // Scanner — only filter is 24h change ≥ minChange24hPercent
  scannerIntervalMs: 1 * 60 * 1000,
  minChange24hPercent: 60,

  // Strategy parameters
  takeProfitPercent: 10,        // Short TP — price drops 10% from entry
  hedgeTriggerPercent: 5,       // Open hedge when short is losing this %
  hedgeStopLossPercent: 5,      // Hedge SL — price drops 5% from hedge entry
  maxHedgesPerTrader: 6,        // Hard cap on hedge cycles before trader force-closes (0 = unlimited)

  recvWindow: 5000
};

module.exports = config;
