import { Schema, model, type InferSchemaType } from 'mongoose';

const TradeSchema = new Schema(
  {
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['LONG', 'SHORT'], required: true },
    mode: { type: String, enum: ['test', 'live'], required: true, index: true },
    entryPrice: { type: Number, required: true },
    exitPrice: { type: Number, required: true },
    qty: { type: Number, required: true },
    notional: { type: Number, required: true },
    pnl: { type: Number, required: true },
    fees: { type: Number, required: true, default: 0 },
    leverage: { type: Number, required: true },
    reason: { type: String, required: true },
    stopPrice: { type: Number, default: null },
    takeProfitPrice: { type: Number, default: null },
    /** What the engine *intended* the fill price to be (SL/TP target). The
     * difference vs `exitPrice` is realized slippage. */
    intendedExitPrice: { type: Number, default: null },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date, required: true, index: true },
    meta: { type: Schema.Types.Mixed },
  },
  { collection: 'trades', timestamps: true },
);

TradeSchema.index({ symbol: 1, closedAt: -1 });
TradeSchema.index({ mode: 1, closedAt: -1 });

export type TradeDoc = InferSchemaType<typeof TradeSchema>;
export const TradeModel = model('Trade', TradeSchema);
