import { Schema, model, type InferSchemaType } from 'mongoose';

const BalanceSchema = new Schema(
  {
    mode: { type: String, enum: ['test', 'live'], required: true, index: true },
    balance: { type: Number, required: true },
    equity: { type: Number, required: true },
    unrealizedPnl: { type: Number, required: true, default: 0 },
    marginUsed: { type: Number, required: true, default: 0 },
    feesPaid: { type: Number, required: true, default: 0 },
    ts: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'balance', timestamps: false },
);

BalanceSchema.index({ mode: 1, ts: -1 });

export type BalanceDoc = InferSchemaType<typeof BalanceSchema>;
export const BalanceModel = model('Balance', BalanceSchema);
