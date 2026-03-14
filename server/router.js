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
    traderType: trader.traderType,
    lastPrice: trader.lastPrice,
    startPrice: trader.startPrice,
    direction: trader.direction,
    entryPrice: trader.entryPrice,
    quantity: trader.quantity,
    stopLossPrice: trader.stopLossPrice,
    takeProfitPrice: trader.takeProfitPrice,
    tpPercent: trader.tpPercent,
    slPercent: trader.slPercent,
    tpProgress: trader.tpProgress,
    leverage: trader.leverage,
    totalTrades: trader.totalTrades,
    wins: trader.wins,
    losses: trader.losses,
    consecutiveWins: trader.consecutiveWins,
    consecutiveLosses: trader.consecutiveLosses,
    maxConsecutiveWins: trader.maxConsecutiveWins,
    maxConsecutiveLosses: trader.maxConsecutiveLosses,
    realizedPnl: trader.realizedPnl,
    unrealizedPnl: trader.unrealizedPnl,
    feesPaid: trader.feesPaid,
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
    direction: trader.direction,
    entryPrice: trader.entryPrice,
    stopLossPrice: trader.stopLossPrice,
    takeProfitPrice: trader.takeProfitPrice,
    tradeHistory: trader.tradeHistory || []
  });
});

router.get("/history", (req, res) => {
  res.json(store.getHistory());
});

router.get("/performance", (req, res) => {
  res.json(store.getPerformance());
});

router.get("/top-gainers", async (req, res) => {
  try {
    res.json({
      error: "Top gainers are now streamed via websocket; use /api/dashboard updates."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
