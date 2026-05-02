import { CONFIG } from '../core/config.js';
import { Side } from '../core/constants.js';
import { scoped } from '../utils/logger.js';

const log = scoped('SETUP');

export type SetupType = 'LONG' | 'SHORT';

export interface Setup {
  symbol: string;
  type: SetupType;
  /** RSI value on the 15m candle that created the setup (for diagnostics). */
  rsiAtCreate: number;
  createdAt: number;
  expiresAt: number;
}

/**
 * SetupService — stateful 15m → 1m sequential signal store.
 *
 * Lifecycle:
 *   1. 15m scanner sees `RANGE && rsi < oversold` (or > overbought)
 *      → calls `create(symbol, 'LONG' | 'SHORT', rsi)`.
 *   2. 1m strategy sees `getActive(symbol)`:
 *      - returns null if no setup OR expired (auto-purged).
 *      - returns the Setup if still within `expiryMs`.
 *   3. On execution, orchestrator calls `consume(symbol)` which invalidates
 *      the setup AND starts a per-symbol cooldown for `cooldownMs`.
 *
 * Concurrency: single-process in-memory map; orchestrator loop is serial.
 */
export class SetupService {
  private readonly setups = new Map<string, Setup>();
  /** symbol → cooldown-until timestamp (ms). */
  private readonly cooldowns = new Map<string, number>();

  /** Create or replace the active setup for `symbol`. */
  create(symbol: string, type: SetupType, rsiAtCreate: number): Setup {
    const cfg = CONFIG();
    const now = Date.now();
    // If an existing setup of the same type is still fresh, keep it (avoid
    // resetting the expiry every scan and giving a 30-min stale signal new life).
    const existing = this.setups.get(symbol);
    if (existing && existing.type === type && existing.expiresAt > now) {
      return existing;
    }
    const setup: Setup = {
      symbol,
      type,
      rsiAtCreate,
      createdAt: now,
      expiresAt: now + cfg.setup.expiryMs,
    };
    this.setups.set(symbol, setup);
    log.info({ symbol, type, rsi: rsiAtCreate, expiresAt: setup.expiresAt }, 'setup_created');
    return setup;
  }

  /** Return the active (non-expired) setup for symbol, or null. */
  getActive(symbol: string): Setup | null {
    const s = this.setups.get(symbol);
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      this.setups.delete(symbol);
      log.info({ symbol, type: s.type }, 'setup_expired');
      return null;
    }
    return s;
  }

  /** Remove a setup explicitly (e.g. after consumption or invalidation). */
  invalidate(symbol: string, reason: string): void {
    const existed = this.setups.delete(symbol);
    if (existed) log.info({ symbol, reason }, 'setup_invalidated');
  }

  /** Mark consumed by an executed entry — invalidate + start cooldown. */
  consume(symbol: string): void {
    const cfg = CONFIG();
    this.invalidate(symbol, 'consumed');
    if (cfg.setup.cooldownMs > 0) {
      this.cooldowns.set(symbol, Date.now() + cfg.setup.cooldownMs);
    }
  }

  /** Returns ms remaining of cooldown, or 0 if symbol is clear. */
  cooldownRemaining(symbol: string): number {
    const until = this.cooldowns.get(symbol);
    if (!until) return 0;
    const left = until - Date.now();
    if (left <= 0) {
      this.cooldowns.delete(symbol);
      return 0;
    }
    return left;
  }

  isOnCooldown(symbol: string): boolean {
    return this.cooldownRemaining(symbol) > 0;
  }

  /** All currently active (non-expired) setups, expiry-purged. */
  active(): Setup[] {
    const now = Date.now();
    const out: Setup[] = [];
    for (const [sym, s] of this.setups) {
      if (s.expiresAt < now) {
        this.setups.delete(sym);
        log.info({ symbol: sym, type: s.type }, 'setup_expired');
        continue;
      }
      out.push(s);
    }
    return out;
  }

  /** Snapshot for /debug — includes setups + cooldowns. */
  snapshot(): { setups: Setup[]; cooldowns: Array<{ symbol: string; remainingMs: number }> } {
    const setups = this.active();
    const cooldowns: Array<{ symbol: string; remainingMs: number }> = [];
    for (const [sym] of this.cooldowns) {
      const r = this.cooldownRemaining(sym);
      if (r > 0) cooldowns.push({ symbol: sym, remainingMs: r });
    }
    return { setups, cooldowns };
  }

  /** Test helper — clears all state. */
  reset(): void {
    this.setups.clear();
    this.cooldowns.clear();
  }
}

/** Helper: map signal side enum to setup type. */
export function sideToSetupType(side: Side): SetupType {
  return side === Side.LONG ? 'LONG' : 'SHORT';
}
