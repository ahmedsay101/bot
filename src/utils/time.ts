export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const nowMs = (): number => Date.now();

export function floorToInterval(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function intervalMs(interval: string): number {
  const v = INTERVAL_MS[interval];
  if (!v) throw new Error(`Unsupported interval: ${interval}`);
  return v;
}
