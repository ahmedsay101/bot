import { describe, it, expect, beforeEach } from 'vitest';
import { SetupService } from '../../src/services/setup.service.js';
import { applySettingsPatch, resetConfig } from '../../src/core/config.js';

beforeEach(() => {
  resetConfig();
  // Short windows so tests stay fast
  applySettingsPatch({ setup: { expiryMs: 1000, cooldownMs: 500 } });
});

describe('SetupService', () => {
  it('creates and returns an active setup', () => {
    const s = new SetupService();
    const setup = s.create('BTCUSDT', 'LONG', 28);
    expect(setup.type).toBe('LONG');
    expect(s.getActive('BTCUSDT')).toEqual(setup);
  });

  it('returns null for unknown symbol', () => {
    const s = new SetupService();
    expect(s.getActive('FOO')).toBeNull();
  });

  it('expires after expiryMs', async () => {
    const s = new SetupService();
    s.create('BTCUSDT', 'LONG', 28);
    await new Promise((r) => setTimeout(r, 1100));
    expect(s.getActive('BTCUSDT')).toBeNull();
  });

  it('preserves existing same-type setup (no expiry refresh)', async () => {
    const s = new SetupService();
    const a = s.create('BTCUSDT', 'LONG', 28);
    await new Promise((r) => setTimeout(r, 50));
    const b = s.create('BTCUSDT', 'LONG', 27);
    expect(b.createdAt).toBe(a.createdAt);
  });

  it('replaces setup on opposite side', () => {
    const s = new SetupService();
    s.create('BTCUSDT', 'LONG', 28);
    const flipped = s.create('BTCUSDT', 'SHORT', 72);
    expect(flipped.type).toBe('SHORT');
    expect(s.getActive('BTCUSDT')?.type).toBe('SHORT');
  });

  it('consume invalidates and starts cooldown', () => {
    const s = new SetupService();
    s.create('BTCUSDT', 'LONG', 28);
    s.consume('BTCUSDT');
    expect(s.getActive('BTCUSDT')).toBeNull();
    expect(s.isOnCooldown('BTCUSDT')).toBe(true);
    expect(s.cooldownRemaining('BTCUSDT')).toBeGreaterThan(0);
  });

  it('cooldown clears after cooldownMs', async () => {
    const s = new SetupService();
    s.create('BTCUSDT', 'LONG', 28);
    s.consume('BTCUSDT');
    await new Promise((r) => setTimeout(r, 600));
    expect(s.isOnCooldown('BTCUSDT')).toBe(false);
  });

  it('snapshot returns active setups + cooldowns', () => {
    const s = new SetupService();
    s.create('BTCUSDT', 'LONG', 28);
    s.create('ETHUSDT', 'SHORT', 72);
    s.consume('ETHUSDT');
    const snap = s.snapshot();
    expect(snap.setups.map((x) => x.symbol)).toEqual(['BTCUSDT']);
    expect(snap.cooldowns.map((x) => x.symbol)).toEqual(['ETHUSDT']);
  });
});
