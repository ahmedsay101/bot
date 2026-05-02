import { Schema, model, type InferSchemaType } from 'mongoose';

const PositionSchema = new Schema(
  {
    symbol: { type: String, required: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
    side: { type: String, enum: ['LONG', 'SHORT'], required: true },
    size: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    leverage: { type: Number, required: true },
    margin: { type: Number, required: true },
    notional: { type: Number, required: true },
    liquidationPrice: { type: Number, required: true },
    stopPrice: { type: Number, required: true },
    takeProfitPrice: { type: Number, required: true },
    openedAt: { type: Date, required: true },
    entryOrderId: { type: String, required: true },
    slOrderId: { type: String, default: null },
    tpOrderId: { type: String, default: null },
    meta: { type: Schema.Types.Mixed },
  },
  { collection: 'positions', timestamps: true },
);

// Only one open position per symbol per mode (per spec maxOpenPositionsPerSymbol=1).
PositionSchema.index({ symbol: 1, mode: 1 }, { unique: true });

export type PositionDoc = InferSchemaType<typeof PositionSchema>;
export const PositionModel = model('Position', PositionSchema);
