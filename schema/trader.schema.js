const mongoose = require('mongoose');

const traderSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    symbol: { type: String, required: true },
    baseAmountIn: { type: mongoose.Types.Decimal128, required: true },
    quoteAmountIn: { type: mongoose.Types.Decimal128, required: false, default: 0},
    leverage: { type: Number, required: false, default: 1},
    profitMultiplier: { type: Number, required: false, default: 2},
    shifts: { type: Number, required: false, default: 0},
    maxShifts: { type: Number, required: false, default: 3},
    maxTransactions: { type: Number, required: false, default: 10},
    profit: { type: mongoose.Types.Decimal128, required: false, default: 0},
    fee: { type: mongoose.Types.Decimal128, required: false, default: 0},
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
