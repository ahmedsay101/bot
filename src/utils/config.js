const config = {
  mode: process.argv.includes("--live") ? "live" : "test",
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  baseRestUrl: "https://fapi.binance.com",
  baseWsUrl: "wss://fstream.binance.com",
  maxTraders: 2,
  enableTradingWindow: false,
  enableScannerFilters: false,
  feeRate: 0.0004,
  slippageRate: 0.0002,
  positionNotionalUSDT: 1,
  leverage: 50,
  takeProfitPercent: 3,
  stopLossPercent: 3,
  startingBalanceUSDT: 80,
  scannerIntervalMs: 1 * 60 * 1000,
  minChange: 1,
  maxChange: 8,
  volumeRatio: 0.15,
  minRangePercent: 1.5,
  depthMin: 200000,
  depthMax: 5000000,
  spreadMin: 0.0001,
  spreadMax: 0.002,
  recvWindow: 5000
};

module.exports = config;
