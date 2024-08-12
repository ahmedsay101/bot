const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    traderId: { type: mongoose.Types.ObjectId, ref: "trader", required: true },
    symbol: { type: String, required: true },
    orderId: { type: String, required: false },
    side: { type: String, enum: ["LONG", "SHORT"], required: true },
    price: { type: mongoose.Types.Decimal128, required: true },
    closingPrice: { type: mongoose.Types.Decimal128, required: false, default: 0},
    baseAmountIn: { type: mongoose.Types.Decimal128, required: true },
    quoteAmountIn: { type: mongoose.Types.Decimal128, required: true },
    baseAmountOut: { type: mongoose.Types.Decimal128, required: false, default: 0 },
    quoteAmountOut: { type: mongoose.Types.Decimal128, required: false, default: 0 },
    shouldCloseAt: { type: mongoose.Types.Decimal128, required: false, default: 0 },
    profit: { type: mongoose.Types.Decimal128, required: false, default: 0 },
    status: { type: String, enum: ["NEW", "FILLED", "CLOSED"], default: "NEW"},
    type: { type: String, enum: ["LIMIT", "MARKET"], default: "MARKET"},
    mode: { type: String, enum: ["TESTING", "LIVE"], default: "TESTING"},
    isProfitable: { type: Boolean, required: false, default: false },
    shifted: { type: Boolean, required: false, default: false },
    closedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

const Transactions = mongoose.model("transaction", transactionSchema);

module.exports = { Transactions };
