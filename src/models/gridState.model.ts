import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Per-symbol snapshot of the grid+hedge state machine. The GridEngine
 * persists its state here on every transition / order action so the dashboard
 * has durable history and the bot can recover on restart.
 */
const GridStateSchema = new Schema(
  {
    symbol: { type: String, required: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
    state: { type: String, enum: ['GRID', 'HEDGE', 'RESET'], required: true },
    upperBand: { type: Number, required: true },
    lowerBand: { type: Number, required: true },
    rangePercent: { type: Number, required: true },
    currentPrice: { type: Number, required: true },
    breakoutDetected: { type: Boolean, default: false },
    breakoutDirection: { type: String, enum: ['UP', 'DOWN', null], default: null },
    hedgeActive: { type: Boolean, default: false },
    netPosition: { type: Number, default: 0 },
    openLongPositions: { type: Number, default: 0 },
    openShortPositions: { type: Number, default: 0 },
    totalOpenPositions: { type: Number, default: 0 },
    hedge: { type: Schema.Types.Mixed, default: null },
    positions: { type: [Schema.Types.Mixed], default: [] },
    levels: { type: [Schema.Types.Mixed], default: [] },
    cooldownUntil: { type: Number, default: 0 },
    lastTransitionAt: { type: Number, default: 0 },
    recentEvents: { type: [Schema.Types.Mixed], default: [] },
  },
  { collection: 'gridStates', timestamps: true },
);

GridStateSchema.index({ symbol: 1, mode: 1 }, { unique: true });

export type GridStateDoc = InferSchemaType<typeof GridStateSchema>;
export const GridStateModel = model('GridState', GridStateSchema);
