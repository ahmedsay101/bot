import { describe, it, expect, beforeEach } from 'vitest';
import { applySettingsPatch, CONFIG, resetConfig } from '../../src/core/config.js';

describe('config', () => {
  beforeEach(() => resetConfig());

  it('starts with defaults from spec', () => {
    expect(CONFIG().trading.maxSymbols).toBe(3);
    expect(CONFIG().trading.leverage).toBe(2);
    expect(CONFIG().thresholds.rsiOverbought).toBe(70);
  });

  it('applies a settings patch', () => {
    applySettingsPatch({ trading: { maxSymbols: 5 } });
    expect(CONFIG().trading.maxSymbols).toBe(5);
    // Other keys preserved
    expect(CONFIG().trading.leverage).toBe(2);
  });

  it('toggles kill switch', () => {
    expect(CONFIG().killSwitch).toBe(false);
    applySettingsPatch({ killSwitch: true });
    expect(CONFIG().killSwitch).toBe(true);
  });
});
