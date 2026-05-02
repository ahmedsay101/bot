import mongoose from 'mongoose';
import { applySettingsPatch, CONFIG, SettingsSchema } from '../core/config.js';
import { Channels } from '../core/constants.js';
import { SettingsModel } from '../models/index.js';
import { publish } from './redis.service.js';
import { scoped } from '../utils/logger.js';

const log = scoped('SETTINGS');

let watcher: mongoose.mongo.ChangeStream | null = null;

export async function loadSettings(): Promise<void> {
  const doc = await SettingsModel.findById('global').lean();
  if (doc?.patch) {
    const parsed = SettingsSchema.safeParse(doc.patch);
    if (parsed.success) {
      applySettingsPatch(parsed.data);
      log.info({ keys: Object.keys(parsed.data) }, 'settings loaded');
    } else {
      log.warn({ err: parsed.error.message }, 'invalid settings doc; ignoring');
    }
  }
}

export async function saveSettings(patch: unknown, updatedBy = 'admin'): Promise<typeof CONFIG extends () => infer R ? R : never> {
  const parsed = SettingsSchema.parse(patch);
  await SettingsModel.updateOne(
    { _id: 'global' },
    { $set: { patch: parsed, updatedBy, updatedAt: new Date() }, $inc: { version: 1 } },
    { upsert: true },
  );
  const cfg = applySettingsPatch(parsed);
  await publish(Channels.CONFIG_UPDATED, { updatedBy, ts: Date.now() });
  return cfg as never;
}

export function startSettingsWatcher(): void {
  if (watcher) return;
  try {
    watcher = SettingsModel.watch([], { fullDocument: 'updateLookup' });
    watcher.on('change', (change) => {
      const fullDoc = (change as unknown as { fullDocument?: { patch?: unknown } }).fullDocument;
      const patch = fullDoc?.patch;
      if (!patch) return;
      const parsed = SettingsSchema.safeParse(patch);
      if (parsed.success) {
        applySettingsPatch(parsed.data);
        log.info('settings hot-reloaded');
      }
    });
    watcher.on('error', (err) => log.warn({ err: err.message }, 'change stream error'));
    log.info('change stream watcher started');
  } catch (e) {
    // Standalone Mongo (no replica set) doesn't support change streams. Fall back silently.
    log.warn({ err: (e as Error).message }, 'change stream unavailable; settings hot-reload disabled');
  }
}

export async function stopSettingsWatcher(): Promise<void> {
  if (!watcher) return;
  await watcher.close();
  watcher = null;
}
