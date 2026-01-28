import { create, useStore } from 'zustand';
import {
  calculateMiniSectorGap,
  smoothGap,
  type ReferenceLap,
  type SectorPoint,
} from './gapCalculation';

const MINI_SECTOR_INTERVAL = 0.005; // 0.5% of lap distance (~200 sectors per lap)
const MIN_SECTORS_FOR_REFERENCE = 180; // 90% coverage required
const GAP_SMOOTHING_SIZE = 5;

interface CarTrackingState {
  currentLapNum: number;
  lapStartTime: number;
  sectors: SectorPoint[];
  lastSectorIdx: number;
  wasOnPitRoad: boolean;
  wasOffTrack: boolean;
}

export interface MiniSectorUpdateParams {
  carIdxLapDistPct: number[];
  carIdxLap: number[];
  carIdxOnPitRoad: boolean[];
  carIdxTrackSurface: number[];
  carIdxLastLapTime: number[];
  sessionTime: number;
  sessionNum: number;
  playerCarIdx: number;
  carIdxClassId: number[];
  carIdxEstLapTime: number[];
}

interface MiniSectorState {
  // Internal tracking (not consumed by components)
  carTracking: Map<number, CarTrackingState>;
  classReferenceLaps: Map<number, ReferenceLap>;
  gapHistory: Map<number, number[]>;
  sessionNum: number | null;

  // Output state (consumed by useDriverRelatives)
  gapToPlayer: number[];
  gapVersion: number;

  // Actions
  update: (params: MiniSectorUpdateParams) => void;
  reset: () => void;
}

function finalizeLap(
  sectors: SectorPoint[],
  lapTime: number
): ReferenceLap | null {
  if (sectors.length < MIN_SECTORS_FOR_REFERENCE || lapTime <= 0) return null;

  // Sort by pct (should mostly be sorted already)
  const sorted = [...sectors].sort((a, b) => a.pct - b.pct);

  // Normalize times to actual lap time
  const lastTime = sorted[sorted.length - 1].time;
  if (lastTime <= 0) return null;
  const scale = lapTime / lastTime;

  const normalized = sorted.map((s) => ({
    pct: s.pct,
    time: s.time * scale,
  }));

  return { sectors: normalized, lapTime };
}

export const useMiniSectorStore = create<MiniSectorState>((set, get) => ({
  carTracking: new Map(),
  classReferenceLaps: new Map(),
  gapHistory: new Map(),
  sessionNum: null,
  gapToPlayer: [],
  gapVersion: 0,

  update: (params) => {
    const state = get();
    const {
      carIdxLapDistPct,
      carIdxLap,
      carIdxOnPitRoad,
      carIdxTrackSurface,
      carIdxLastLapTime,
      sessionTime,
      sessionNum,
      playerCarIdx,
      carIdxClassId,
      carIdxEstLapTime,
    } = params;

    // Session change: reset
    if (state.sessionNum !== null && sessionNum !== state.sessionNum) {
      get().reset();
      return;
    }

    const carTracking = state.carTracking;
    const classReferenceLaps = state.classReferenceLaps;
    // Phase 1: Collect sectors and detect lap completions
    for (let carIdx = 0; carIdx < carIdxLapDistPct.length; carIdx++) {
      const pct = carIdxLapDistPct[carIdx];
      const lapNum = carIdxLap[carIdx];
      if (pct === undefined || pct < 0 || lapNum === undefined || lapNum <= 0)
        continue;

      const isOnPitRoad = carIdxOnPitRoad[carIdx] ?? false;
      // TrackSurface: -1=NotInWorld, 0=OffTrack, 1=InPitStall, 2=AproachingPits, 3=OnTrack
      const trackSurface = carIdxTrackSurface[carIdx] ?? -1;
      const isOffTrack = trackSurface === 0;

      const sectorIdx = Math.floor(pct / MINI_SECTOR_INTERVAL);
      let tracking = carTracking.get(carIdx);

      if (!tracking || tracking.currentLapNum !== lapNum) {
        // New lap started — finalize old lap if we have one
        if (tracking && !tracking.wasOnPitRoad && !tracking.wasOffTrack) {
          const lapTime = carIdxLastLapTime[carIdx] ?? 0;
          if (lapTime > 0 && lapTime < 600) {
            const refLap = finalizeLap(tracking.sectors, lapTime);
            if (refLap) {
              const classId = carIdxClassId[carIdx] ?? 0;
              const existing = classReferenceLaps.get(classId);
              if (!existing || lapTime < existing.lapTime) {
                classReferenceLaps.set(classId, refLap);
              }
            }
          }
        }

        // Estimate lap start time
        const estLapTime =
          carIdxEstLapTime[carIdx] ||
          classReferenceLaps.get(carIdxClassId[carIdx] ?? 0)?.lapTime ||
          90;
        const estimatedElapsed = pct * estLapTime;

        tracking = {
          currentLapNum: lapNum,
          lapStartTime: sessionTime - estimatedElapsed,
          sectors: [],
          lastSectorIdx: -1,
          wasOnPitRoad: isOnPitRoad,
          wasOffTrack: isOffTrack,
        };
        carTracking.set(carIdx, tracking);
      }

      // Track dirty status
      if (isOnPitRoad) tracking.wasOnPitRoad = true;
      if (isOffTrack) tracking.wasOffTrack = true;

      // Record sector if new
      if (sectorIdx !== tracking.lastSectorIdx) {
        const elapsed = sessionTime - tracking.lapStartTime;
        if (elapsed > 0 && elapsed < 600) {
          tracking.sectors.push({
            pct: sectorIdx * MINI_SECTOR_INTERVAL,
            time: elapsed,
          });
          tracking.lastSectorIdx = sectorIdx;
        }
      }
    }

    // Phase 2: Compute gaps relative to player
    const playerPct = carIdxLapDistPct[playerCarIdx];
    if (playerPct === undefined || playerPct < 0) {
      set({ sessionNum });
      return;
    }

    const playerClassId = carIdxClassId[playerCarIdx] ?? 0;
    const gapHistory = state.gapHistory;
    const newGapToPlayer: number[] = new Array(carIdxLapDistPct.length).fill(0);
    let gapChanged = false;

    for (let carIdx = 0; carIdx < carIdxLapDistPct.length; carIdx++) {
      if (carIdx === playerCarIdx) continue;

      const otherPct = carIdxLapDistPct[carIdx];
      if (otherPct === undefined || otherPct < 0) continue;

      const otherClassId = carIdxClassId[carIdx] ?? 0;

      // Select reference lap: prefer the other car's class, fall back to player's class
      const refLap =
        classReferenceLaps.get(otherClassId) ||
        classReferenceLaps.get(playerClassId);

      if (!refLap) continue;

      const rawGap = calculateMiniSectorGap(playerPct, otherPct, refLap);
      if (rawGap === null) continue;

      // Apply smoothing
      let history = gapHistory.get(carIdx);
      if (!history) {
        history = [];
        gapHistory.set(carIdx, history);
      }
      const smoothed = smoothGap(rawGap, history, GAP_SMOOTHING_SIZE);
      newGapToPlayer[carIdx] = smoothed;
      gapChanged = true;
    }

    set({
      sessionNum,
      gapToPlayer: gapChanged ? newGapToPlayer : state.gapToPlayer,
      gapVersion: gapChanged
        ? state.gapVersion + 1
        : state.gapVersion,
    });
  },

  reset: () => {
    set({
      carTracking: new Map(),
      classReferenceLaps: new Map(),
      gapHistory: new Map(),
      sessionNum: null,
      gapToPlayer: [],
      gapVersion: 0,
    });
  },
}));

// Stable empty array for O(1) equality
const EMPTY_GAPS: number[] = [];
let lastGapVersion = -1;
let lastGaps: number[] = EMPTY_GAPS;

/**
 * Returns gap-to-player array indexed by carIdx (seconds, + ahead, - behind).
 * Uses version-based equality for O(1) comparison at 60 FPS.
 */
export const useMiniSectorGaps = (): number[] => {
  return useStore(useMiniSectorStore, (state) => {
    if (state.gapToPlayer.length === 0) return EMPTY_GAPS;
    if (state.gapVersion === lastGapVersion) return lastGaps;
    lastGapVersion = state.gapVersion;
    lastGaps = state.gapToPlayer;
    return state.gapToPlayer;
  });
};

/**
 * Returns whether the mini-sector store has any reference lap data.
 */
export const useMiniSectorHasData = (): boolean => {
  return useStore(
    useMiniSectorStore,
    (state) => state.classReferenceLaps.size > 0
  );
};
