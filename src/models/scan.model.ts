import { Schema, model, type InferSchemaType } from 'mongoose';

const ScanSchema = new Schema(
  {
    ts: { type: Date, required: true, default: () => new Date(), index: true },
    selected: [{ type: String }],
    candidates: [
      {
        symbol: String,
        price: Number,
        atr: Number,
        rsi: Number,
        ma: Number,
        slope: Number,
        volatilityScore: Number,
        trendScore: Number,
        score: Number,
        regime: String,
        skipped: Boolean,
        skipReason: String,
      },
    ],
  },
  { collection: 'scans', timestamps: false },
);

export type ScanDoc = InferSchemaType<typeof ScanSchema>;
export const ScanModel = model('Scan', ScanSchema);
