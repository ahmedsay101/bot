const mongoose = require('mongoose');

const traderSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    baseAmountIn: { type: Number, required: true },
    quoteAmountIn: { type: Number, required: false, default: 0},
    prices: { type: [Number], "default": [] },
    leverage: { type: Number, required: false, default: 1},
    profit: { type: Number, required: false, default: 0},
    profitTaken: { type: Number, required: false, default: 0},
    moneyIn: { type: Number, required: false, default: 0},
    takeProfit: { type: Number, required: false, default: 0 },
    stopLoss: { type: Number, required: false, default: 0 },
    fee: { type: Number, required: false, default: 0},
    status: { type: String, enum: ["ACTIVE", "STOPPED"], default: "ACTIVE"},
    mode: { type: String, enum: ["TESTING", "LIVE"], default: "TESTING"},
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

const Traders = mongoose.model("trader", traderSchema);
module.exports = { Traders };
