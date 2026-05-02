import { describe, it, expect } from 'vitest';
import { quantize, createRng, randomInRange, round } from '../../src/utils/math.js';

describe('math', () => {
  it('round', () => {
    expect(round(1.23456789, 4)).toBeCloseTo(1.2346);
    expect(round(-1.23456789, 4)).toBeCloseTo(-1.2346);
  });
  it('quantize floors to step', () => {
    expect(quantize(1.2345, 0.01)).toBeCloseTo(1.23);
    expect(quantize(0.0009, 0.001)).toBe(0);
    expect(quantize(5.7, 1)).toBe(5);
  });
  it('createRng deterministic for same seed', () => {
    const a = createRng('seed-1');
    const b = createRng('seed-1');
    for (let i = 0; i < 5; i++) expect(a()).toBeCloseTo(b());
  });
  it('randomInRange respects bounds', () => {
    const r = createRng('x');
    for (let i = 0; i < 100; i++) {
      const v = randomInRange(r, 5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
    }
  });
});
