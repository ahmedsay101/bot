const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    traderId: { type: mongoose.Types.ObjectId, ref: "trader", required: true },
    symbol: { type: String, required: true },
    orderId: { type: String, required: false },
    takeProfitOrderId: { type: String, required: false },
    stopLossOrderId: { type: String, required: false },
    side: { type: String, enum: ["LONG", "SHORT"], required: true },
    price: { type: Number, required: true },
    closingPrice: { type: Number, required: false, default: 0},
    baseAmountIn: { type: Number, required: true },
    quoteAmountIn: { type: Number, required: false, default: 0},
    baseAmountOut: { type: Number, required: false, default: 0 },
    quoteAmountOut: { type: Number, required: false, default: 0 },
    expectedAmountOut: { type: Number, required: false, default: 0 },
    expectedProfit: { type: Number, required: false, default: 0 },
    takeProfit: { type: Number, required: false, default: 0 },
    stopLoss: { type: Number, required: false, default: 0 },
    profit: { type: Number, required: false, default: 0 },
    currentTakeProfit: { type: Number, required: false, default: 0 },
    takeProfitStep: { type: Number, required: false, default: 1 },
    readyToTakeProfit: { type: Boolean, required: false, default: false },
    status: { type: String, enum: ["NEW", "FILLED", "CLOSED"], default: "NEW"},
    type: { type: String, enum: ["LIMIT", "MARKET", "STOP_MARKET"], default: "MARKET"},
    mode: { type: String, enum: ["TESTING", "LIVE"], default: "TESTING"},
    position: { type: String, enum: ["HIGHER", "LOWER"], required: false },
    isProfitable: { type: Boolean, required: false, default: false },
    closedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

const Transactions = mongoose.model("transaction", transactionSchema);

module.exports = { Transactions };
