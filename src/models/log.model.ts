import { Schema, model, type InferSchemaType } from 'mongoose';

// Capped collection — created on first connect via db service.
const LogSchema = new Schema(
  {
    ts: { type: Date, required: true, default: () => new Date() },
    level: { type: String, required: true, index: true },
    scope: { type: String, default: 'app', index: true },
    message: { type: String, required: true },
    meta: { type: Schema.Types.Mixed },
  },
  {
    collection: 'logs',
    capped: { size: 50 * 1024 * 1024, max: 100_000 },
    timestamps: false,
  },
);

export type LogDoc = InferSchemaType<typeof LogSchema>;
export const LogModel = model('Log', LogSchema);
