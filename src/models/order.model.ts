import { Schema, model, type InferSchemaType } from 'mongoose';

const OrderSchema = new Schema(
  {
    clientOrderId: { type: String, required: true, unique: true },
    exchangeOrderId: { type: String, default: null },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    positionSide: { type: String, enum: ['LONG', 'SHORT'], required: true },
    type: {
      type: String,
      enum: ['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'],
      required: true,
    },
    status: {
      type: String,
      enum: ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'],
      required: true,
      default: 'NEW',
      index: true,
    },
    mode: { type: String, enum: ['test', 'live'], required: true, index: true },
    price: { type: Number, default: null },
    stopPrice: { type: Number, default: null },
    qty: { type: Number, required: true },
    filledQty: { type: Number, default: 0 },
    avgFillPrice: { type: Number, default: 0 },
    fees: { type: Number, default: 0 },
    reduceOnly: { type: Boolean, default: false },
    purpose: { type: String, enum: ['ENTRY', 'EXIT', 'SL', 'TP'], required: true },
    error: { type: String, default: null },
  },
  { collection: 'orders', timestamps: true },
);

OrderSchema.index({ status: 1, mode: 1, createdAt: -1 });
OrderSchema.index({ symbol: 1, createdAt: -1 });

export type OrderDoc = InferSchemaType<typeof OrderSchema>;
export const OrderModel = model('Order', OrderSchema);
