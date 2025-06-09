const mongoose = require('mongoose');

const traderSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    baseAmountIn: { type: Number, required: true },
    quoteAmountIn: { type: Number, required: false, default: 0},
    maxBaseAmountIn: { type: Number, required: false, default: 0 },
    levels: { type: [Number], "default": [] },
    leverage: { type: Number, required: false, default: 1},
    profit: { type: Number, required: false, default: 0},
    peak: { type: Number, required: false, default: 0},
    totalProfit: { type: Number, required: false, default: 0},    
    lives: { type: Number, required: false, default: 0},    
    maxLevels: { type: Number, required: false, default: 5},
    maxMoneyIn: { type: Number, required: false, default: 0},
    coverage: { type: Number, required: false, default: 0},
    requiredTransactions: { type: Number, required: false, default: 0},
    requiredBalance: { type: Number, required: false, default: 0},
    accumulatedProfit: { type: Number, required: false, default: 0},
    aim: { type: Number, required: false, default: 0},
    hours: { type: Number, required: false, default: 0},
    timeLeft: { type: Number, required: false, default: 0},
    profitTaken: { type: Number, required: false, default: 0},
    moneyIn: { type: Number, required: false, default: 0},
    takeProfit: { type: Number, required: false, default: 0 },
    stopLoss: { type: Number, required: false, default: 0 },
    stepSize: { type: Number, required: false, default: 0 },
    currentTakeProfit: { type: Number, required: false, default: 0 },
    takeProfitStep: { type: Number, required: false, default: 1 },
    readyToTakeProfit: { type: Boolean, required: false, default: false },
    isMarketActive: { type: Boolean, required: false, default: false },
    fee: { type: Number, required: false, default: 0},
    doubles: { type: Number, required: false, default: 0},
    rounds: { type: Number, required: false, default: 0},
    currentRounds: { type: Number, required: false, default: 0},
    type: { type: String, enum: ["UNLIMITED", "LIMITED", "RANGE", "TIMED"], default: "UNLIMITED"},
    starts: { type: String, enum: ["NOW", "ACTIVE_HOURS", "MARKET_ACTIVE"], default: "MARKET_ACTIVE"},
    status: { type: String, enum: ["ACTIVE", "STOPPED"], default: "STOPPED"},
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
