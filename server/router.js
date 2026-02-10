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
    lastPrice: trader.lastPrice,
    sideExposure: trader.sideExposure,
    openPositions: trader.openPositions,
    pendingOrders: trader.pendingOrders,
    realizedPnl: trader.realizedPnl,
    unrealizedPnl: trader.unrealizedPnl,
    basePrice: trader.gridLevels?.basePrice || null,
    gridLevels: trader.gridLevels || null,
    createdAt: trader.createdAt,
    openPositionsDetail: trader.openPositionsDetail || [],
    status: trader.status
  }));
  res.json(traders);
});

router.get("/traders/:id", (req, res) => {
  const trader = store.getTrader(req.params.id);
  if (!trader) return res.status(404).json({ error: "Trader not found" });

  res.json({
    symbol: trader.symbol,
    gridLevels: trader.gridLevels,
    openPositions: trader.openPositionsDetail || [],
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

module.exports = router;
