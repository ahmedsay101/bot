import { Schema, model, type InferSchemaType } from 'mongoose';

const KlineCacheSchema = new Schema(
  {
    symbol: { type: String, required: true },
    interval: { type: String, required: true },
    openTime: { type: Number, required: true },
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, required: true },
    closeTime: { type: Number, required: true },
  },
  { collection: 'klineCache', timestamps: false },
);

KlineCacheSchema.index({ symbol: 1, interval: 1, openTime: 1 }, { unique: true });

export type KlineCacheDoc = InferSchemaType<typeof KlineCacheSchema>;
export const KlineCacheModel = model('KlineCache', KlineCacheSchema);
