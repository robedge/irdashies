export interface SectorPoint {
  /** Lap distance percentage (0-1) */
  pct: number;
  /** Elapsed time from lap start in seconds */
  time: number;
}

export interface ReferenceLap {
  /** Array of mini-sector entries (~200 per lap at 0.5% intervals) sorted by pct */
  sectors: SectorPoint[];
  /** Total lap time in seconds */
  lapTime: number;
}

/**
 * Get the elapsed time at a given track position using linear interpolation
 * between recorded mini-sector points.
 *
 * Returns null if the reference lap has insufficient data.
 */
export function timeAtPosition(
  pct: number,
  referenceLap: ReferenceLap
): number | null {
  const { sectors, lapTime } = referenceLap;
  if (sectors.length < 2) return null;

  // Normalize pct to 0-1
  pct = ((pct % 1) + 1) % 1;

  // Before first sector: extrapolate from start
  if (pct <= sectors[0].pct) {
    if (sectors[0].pct === 0) return sectors[0].time;
    const rate = sectors[0].time / sectors[0].pct;
    return pct * rate;
  }

  // After last sector: extrapolate to finish
  const last = sectors[sectors.length - 1];
  if (pct >= last.pct) {
    const remaining = 1 - last.pct;
    if (remaining <= 0) return lapTime;
    const rate = (lapTime - last.time) / remaining;
    return last.time + (pct - last.pct) * rate;
  }

  // Binary search for bracketing sectors
  let lo = 0;
  let hi = sectors.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (sectors[mid].pct <= pct) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Linear interpolation between sectors[lo] and sectors[hi]
  const pctRange = sectors[hi].pct - sectors[lo].pct;
  if (pctRange === 0) return sectors[lo].time;
  const fraction = (pct - sectors[lo].pct) / pctRange;
  return sectors[lo].time + fraction * (sectors[hi].time - sectors[lo].time);
}

/**
 * Calculate the time gap between two cars using mini-sector interpolation.
 *
 * Returns positive if the other car is ahead, negative if behind.
 * Returns null if no interpolation is possible (insufficient data).
 */
export function calculateMiniSectorGap(
  playerPct: number,
  otherPct: number,
  referenceLap: ReferenceLap
): number | null {
  const playerTime = timeAtPosition(playerPct, referenceLap);
  const otherTime = timeAtPosition(otherPct, referenceLap);

  if (playerTime === null || otherTime === null) return null;

  let gap = otherTime - playerTime;

  // Handle S/F line wrap-around
  const halfLap = referenceLap.lapTime / 2;
  if (gap > halfLap) {
    gap -= referenceLap.lapTime;
  } else if (gap < -halfLap) {
    gap += referenceLap.lapTime;
  }

  return gap;
}

const DEFAULT_SMOOTHING_SIZE = 5;

/**
 * Apply exponential moving average smoothing to a gap value.
 *
 * Mutates the history array in place for performance.
 * Returns the smoothed gap value.
 */
export function smoothGap(
  currentGap: number,
  history: number[],
  size: number = DEFAULT_SMOOTHING_SIZE
): number {
  history.push(currentGap);
  if (history.length > size) {
    history.shift();
  }

  if (history.length === 1) return currentGap;

  const alpha = 0.4;
  let ema = history[0];
  for (let i = 1; i < history.length; i++) {
    ema = alpha * history[i] + (1 - alpha) * ema;
  }

  return ema;
}
