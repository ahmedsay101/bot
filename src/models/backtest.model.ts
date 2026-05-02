import { Schema, model, type InferSchemaType } from 'mongoose';

const BacktestSchema = new Schema(
  {
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    fromTs: { type: Number, required: true },
    toTs: { type: Number, required: true },
    paramsPatch: { type: Schema.Types.Mixed, default: {} },
    startingBalance: { type: Number, required: true },
    progress: { type: Number, default: 0 },
    metrics: {
      finalEquity: Number,
      netPnl: Number,
      grossProfit: Number,
      grossLoss: Number,
      fees: Number,
      trades: Number,
      wins: Number,
      losses: Number,
      winRate: Number,
      maxDrawdown: Number,
      sharpe: Number,
    },
    equityCurve: [{ ts: Number, equity: Number }],
    trades: [{ type: Schema.Types.Mixed }],
    error: { type: String, default: null },
  },
  { collection: 'backtests', timestamps: true },
);

export type BacktestDoc = InferSchemaType<typeof BacktestSchema>;
export const BacktestModel = model('Backtest', BacktestSchema);
