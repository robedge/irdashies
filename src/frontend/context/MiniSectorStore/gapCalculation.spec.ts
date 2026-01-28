import { describe, it, expect } from 'vitest';
import {
  timeAtPosition,
  calculateMiniSectorGap,
  smoothGap,
  type ReferenceLap,
} from './gapCalculation';

/**
 * Helper: create a reference lap with uniform sectors (constant speed).
 * With uniform speed, time at position p = p * lapTime.
 */
function uniformReferenceLap(
  lapTime: number,
  numSectors = 200
): ReferenceLap {
  const sectors = [];
  for (let i = 1; i <= numSectors; i++) {
    const pct = i / numSectors;
    sectors.push({ pct, time: pct * lapTime });
  }
  return { sectors, lapTime };
}

/**
 * Helper: create a reference lap where the first half of the track
 * takes 70% of the lap time (slow section) and the second half takes 30%.
 */
function nonUniformReferenceLap(lapTime: number): ReferenceLap {
  const sectors = [];
  const numSectors = 200;
  for (let i = 1; i <= numSectors; i++) {
    const pct = i / numSectors;
    // First half: slow (0-0.5 maps to 0-0.7 of lap time)
    // Second half: fast (0.5-1.0 maps to 0.7-1.0 of lap time)
    const time =
      pct <= 0.5
        ? (pct / 0.5) * 0.7 * lapTime
        : 0.7 * lapTime + ((pct - 0.5) / 0.5) * 0.3 * lapTime;
    sectors.push({ pct, time });
  }
  return { sectors, lapTime };
}

describe('timeAtPosition', () => {
  it('should return null for insufficient data', () => {
    expect(timeAtPosition(0.5, { sectors: [], lapTime: 100 })).toBeNull();
    expect(
      timeAtPosition(0.5, { sectors: [{ pct: 0.5, time: 50 }], lapTime: 100 })
    ).toBeNull();
  });

  it('should interpolate linearly for uniform lap', () => {
    const ref = uniformReferenceLap(100);
    expect(timeAtPosition(0.5, ref)).toBeCloseTo(50, 1);
    expect(timeAtPosition(0.25, ref)).toBeCloseTo(25, 1);
    expect(timeAtPosition(0.75, ref)).toBeCloseTo(75, 1);
  });

  it('should account for non-uniform track sections', () => {
    const ref = nonUniformReferenceLap(100);
    // At 50% of track, 70% of lap time has elapsed
    expect(timeAtPosition(0.5, ref)).toBeCloseTo(70, 0);
    // At 25% of track (midway through slow section), ~35s elapsed
    expect(timeAtPosition(0.25, ref)).toBeCloseTo(35, 0);
    // At 75% of track (midway through fast section), ~85s elapsed
    expect(timeAtPosition(0.75, ref)).toBeCloseTo(85, 0);
  });

  it('should extrapolate before first sector', () => {
    const ref: ReferenceLap = {
      sectors: [
        { pct: 0.1, time: 10 },
        { pct: 0.5, time: 50 },
      ],
      lapTime: 100,
    };
    // Rate = 10 / 0.1 = 100 per pct unit. At pct=0.05 → 5
    expect(timeAtPosition(0.05, ref)).toBeCloseTo(5, 1);
  });

  it('should extrapolate after last sector', () => {
    const ref: ReferenceLap = {
      sectors: [
        { pct: 0.1, time: 10 },
        { pct: 0.9, time: 90 },
      ],
      lapTime: 100,
    };
    // remaining = 1 - 0.9 = 0.1, rate = (100-90)/0.1 = 100. At pct=0.95 → 90 + 5 = 95
    expect(timeAtPosition(0.95, ref)).toBeCloseTo(95, 1);
  });

  it('should handle pct at 0', () => {
    const ref = uniformReferenceLap(100);
    expect(timeAtPosition(0, ref)).toBeCloseTo(0, 1);
  });

  it('should handle pct at 1 (wraps to 0 on circular track)', () => {
    const ref = uniformReferenceLap(100);
    // pct=1.0 normalizes to 0.0 (same physical position as start/finish)
    expect(timeAtPosition(1, ref)).toBeCloseTo(0, 1);
  });

  it('should normalize negative pct values', () => {
    const ref = uniformReferenceLap(100);
    // -0.1 should normalize to 0.9
    expect(timeAtPosition(-0.1, ref)).toBeCloseTo(90, 1);
  });
});

describe('calculateMiniSectorGap', () => {
  it('should return null with insufficient reference data', () => {
    expect(
      calculateMiniSectorGap(0.5, 0.6, { sectors: [], lapTime: 100 })
    ).toBeNull();
  });

  it('should return positive gap when other car is ahead', () => {
    const ref = uniformReferenceLap(100);
    const gap = calculateMiniSectorGap(0.5, 0.6, ref);
    expect(gap).toBeCloseTo(10, 1);
  });

  it('should return negative gap when other car is behind', () => {
    const ref = uniformReferenceLap(100);
    const gap = calculateMiniSectorGap(0.5, 0.4, ref);
    expect(gap).toBeCloseTo(-10, 1);
  });

  it('should return zero for same position', () => {
    const ref = uniformReferenceLap(100);
    const gap = calculateMiniSectorGap(0.5, 0.5, ref);
    expect(gap).toBeCloseTo(0, 1);
  });

  it('should handle S/F line wrap-around (other near finish, player near start)', () => {
    const ref = uniformReferenceLap(100);
    // Player at 0.05, other at 0.95. Raw gap = 90, which > 50 (half lap).
    // Should wrap to 90 - 100 = -10 (other is actually behind by 10s)
    const gap = calculateMiniSectorGap(0.05, 0.95, ref);
    expect(gap).toBeCloseTo(-10, 1);
  });

  it('should handle S/F line wrap-around (other near start, player near finish)', () => {
    const ref = uniformReferenceLap(100);
    // Player at 0.95, other at 0.05. Raw gap = -90, which < -50.
    // Should wrap to -90 + 100 = 10 (other is ahead by 10s)
    const gap = calculateMiniSectorGap(0.95, 0.05, ref);
    expect(gap).toBeCloseTo(10, 1);
  });

  it('should give different gaps for non-uniform track', () => {
    const ref = nonUniformReferenceLap(100);
    // In the slow section (0-0.5), 10% distance = 14% time = 14s
    const gapSlow = calculateMiniSectorGap(0.2, 0.3, ref);
    expect(gapSlow).toBeCloseTo(14, 0);

    // In the fast section (0.5-1.0), 10% distance = 6% time = 6s
    const gapFast = calculateMiniSectorGap(0.7, 0.8, ref);
    expect(gapFast).toBeCloseTo(6, 0);
  });
});

describe('smoothGap', () => {
  it('should return current gap for first value', () => {
    const history: number[] = [];
    expect(smoothGap(10, history)).toBe(10);
    expect(history).toEqual([10]);
  });

  it('should smooth toward recent values', () => {
    const history: number[] = [];
    smoothGap(10, history);
    const result = smoothGap(20, history);
    // EMA: alpha=0.4, start=10, next=0.4*20 + 0.6*10 = 14
    expect(result).toBeCloseTo(14, 1);
  });

  it('should respect history size limit', () => {
    const history: number[] = [];
    for (let i = 0; i < 10; i++) {
      smoothGap(i, history, 5);
    }
    expect(history).toHaveLength(5);
  });

  it('should converge to stable value', () => {
    const history: number[] = [];
    let result = 0;
    for (let i = 0; i < 20; i++) {
      result = smoothGap(50, history, 5);
    }
    expect(result).toBeCloseTo(50, 1);
  });
});
