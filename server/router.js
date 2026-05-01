const express = require("express");
const store = require("../src/state/store");
const router = express.Router();

router.get("/status", (req, res) => {
  res.json(store.getStatus());
});

router.get("/traders", (req, res) => {
  const traders = store.getTraders().map((trader) => ({
    id: trader.id,
    symbol: trader.symbol,
    direction: trader.direction,
    transactionCount: trader.transactionCount,
    accumulatedTpPercent: trader.accumulatedTpPercent,
    accumulatedSlPercent: trader.accumulatedSlPercent,
    netProfitPercent: trader.netProfitPercent,
    profitTargetPercent: trader.profitTargetPercent,
    consecutiveSl: trader.consecutiveSl,
    consecutiveSlFlipCount: trader.consecutiveSlFlipCount,
    lastPrice: trader.lastPrice,
    startPrice: trader.startPrice,
    entryPrice: trader.entryPrice,
    leverage: trader.leverage,
    notional: trader.notional,
    margin: trader.margin,
    takeProfitPercent: trader.takeProfitPercent,
    stopLossPercent: trader.stopLossPercent,
    quantity: trader.quantity,
    tpPrice: trader.tpPrice,
    slPrice: trader.slPrice,
    realizedPnl: trader.realizedPnl,
    unrealizedPnl: trader.unrealizedPnl,
    feesPaid: trader.feesPaid,
    highestNetProfit: trader.highestNetProfit,
    totalTrades: trader.totalTrades,
    tradeHistory: trader.tradeHistory || [],
    createdAt: trader.createdAt,
    status: trader.status
  }));
  res.json(traders);
});

router.get("/traders/:id", (req, res) => {
  const trader = store.getTrader(req.params.id);
  if (!trader) return res.status(404).json({ error: "Trader not found" });

  res.json({
    symbol: trader.symbol,
    startPrice: trader.startPrice,
    entryPrice: trader.entryPrice,
    tpPrice: trader.tpPrice,
    slPrice: trader.slPrice,
    quantity: trader.quantity,
    highestNetProfit: trader.highestNetProfit,
    totalTrades: trader.totalTrades,
    tradeHistory: trader.tradeHistory || []
  });
});

router.get("/history", (req, res) => {
  res.json(store.getHistory());
});

router.get("/performance", (req, res) => {
  res.json(store.getPerformance());
});

router.get("/top-gainers", (req, res) => {
  const getter = req.app.get("getTopGainers");
  res.json(typeof getter === "function" ? getter() : []);
});

router.delete("/traders/:symbol", async (req, res) => {
  const controller = req.app.get("controller");
  if (!controller) return res.status(503).json({ error: "Bot not ready" });

  const { symbol } = req.params;
  try {
    const destroyed = await controller.destroyTrader(symbol);
    if (!destroyed) return res.status(404).json({ error: `No active trader for ${symbol}` });
    res.json({ ok: true, symbol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
