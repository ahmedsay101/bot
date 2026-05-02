import { Schema, model, type InferSchemaType } from 'mongoose';

// Singleton document — _id always = 'global'.
const SettingsSchema = new Schema(
  {
    _id: { type: String, default: 'global' },
    patch: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: String, default: 'system' },
    updatedAt: { type: Date, default: () => new Date() },
    version: { type: Number, default: 1 },
  },
  { collection: 'settings', _id: false },
);

export type SettingsDoc = InferSchemaType<typeof SettingsSchema>;
export const SettingsModel = model('Settings', SettingsSchema);
