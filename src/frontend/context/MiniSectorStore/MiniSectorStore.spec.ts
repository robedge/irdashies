import { describe, it, expect, beforeEach } from 'vitest';
import { useMiniSectorStore, type MiniSectorUpdateParams } from './MiniSectorStore';

function makeParams(
  overrides: Partial<MiniSectorUpdateParams> = {}
): MiniSectorUpdateParams {
  return {
    carIdxLapDistPct: [0.5],
    carIdxLap: [1],
    carIdxOnPitRoad: [false],
    carIdxTrackSurface: [3], // OnTrack
    carIdxLastLapTime: [0],
    sessionTime: 50,
    sessionNum: 1,
    playerCarIdx: 0,
    carIdxClassId: [1],
    carIdxEstLapTime: [100],
    ...overrides,
  };
}

/**
 * Simulate a full clean lap for a car by calling update at each sector.
 */
function simulateFullLap(
  carIdx: number,
  lapNum: number,
  lapTime: number,
  classId: number,
  numCars: number,
  startTime = 0
) {
  const store = useMiniSectorStore.getState();
  const numSectors = 200;

  for (let i = 0; i <= numSectors; i++) {
    const pct = i / numSectors;
    const time = startTime + pct * lapTime;

    const carIdxLapDistPct = new Array(numCars).fill(-1);
    const carIdxLap = new Array(numCars).fill(0);
    const carIdxOnPitRoad = new Array(numCars).fill(false);
    const carIdxTrackSurface = new Array(numCars).fill(3);
    const carIdxLastLapTime = new Array(numCars).fill(0);
    const carIdxClassId = new Array(numCars).fill(classId);
    const carIdxEstLapTime = new Array(numCars).fill(lapTime);

    carIdxLapDistPct[carIdx] = pct;
    carIdxLap[carIdx] = lapNum;

    store.update({
      carIdxLapDistPct,
      carIdxLap,
      carIdxOnPitRoad,
      carIdxTrackSurface,
      carIdxLastLapTime,
      sessionTime: time,
      sessionNum: 1,
      playerCarIdx: 0,
      carIdxClassId,
      carIdxEstLapTime,
    });
  }
}

describe('MiniSectorStore', () => {
  beforeEach(() => {
    useMiniSectorStore.getState().reset();
  });

  it('should start with empty state', () => {
    const state = useMiniSectorStore.getState();
    expect(state.gapToPlayer).toEqual([]);
    expect(state.gapVersion).toBe(0);
    expect(state.classReferenceLaps.size).toBe(0);
  });

  it('should reset on session change', () => {
    const store = useMiniSectorStore.getState();

    // Initialize with session 1
    store.update(makeParams({ sessionNum: 1 }));
    expect(useMiniSectorStore.getState().sessionNum).toBe(1);

    // Change to session 2 → reset
    store.update(makeParams({ sessionNum: 2 }));
    const state = useMiniSectorStore.getState();
    expect(state.sessionNum).toBeNull();
    expect(state.carTracking.size).toBe(0);
  });

  it('should collect sectors for a car', () => {
    const store = useMiniSectorStore.getState();

    // Simulate car at different positions
    store.update(makeParams({ carIdxLapDistPct: [0.01], sessionTime: 1 }));
    store.update(makeParams({ carIdxLapDistPct: [0.02], sessionTime: 2 }));
    store.update(makeParams({ carIdxLapDistPct: [0.03], sessionTime: 3 }));

    const tracking = useMiniSectorStore.getState().carTracking.get(0);
    expect(tracking).toBeDefined();
    expect(tracking?.sectors.length).toBeGreaterThan(0);
  });

  it('should build a reference lap after a full clean lap', () => {
    // Simulate car 0 completing lap 1
    simulateFullLap(0, 1, 100, 1, 1);

    // Trigger lap 2 to finalize lap 1
    const store = useMiniSectorStore.getState();
    store.update(
      makeParams({
        carIdxLapDistPct: [0.01],
        carIdxLap: [2],
        carIdxLastLapTime: [100],
        sessionTime: 101,
      })
    );

    const state = useMiniSectorStore.getState();
    const refLap = state.classReferenceLaps.get(1);
    expect(refLap).toBeDefined();
    expect(refLap?.lapTime).toBe(100);
    expect(refLap?.sectors.length).toBeGreaterThanOrEqual(MIN_SECTORS);
  });

  it('should NOT build reference lap for dirty laps (pit road)', () => {
    const store = useMiniSectorStore.getState();
    const numSectors = 200;

    // Simulate a lap where car is on pit road
    for (let i = 0; i <= numSectors; i++) {
      const pct = i / numSectors;
      store.update(
        makeParams({
          carIdxLapDistPct: [pct],
          carIdxLap: [1],
          carIdxOnPitRoad: [i < 20], // On pit road for first 20 sectors
          sessionTime: pct * 100,
        })
      );
    }

    // Trigger new lap
    store.update(
      makeParams({
        carIdxLapDistPct: [0.01],
        carIdxLap: [2],
        carIdxLastLapTime: [100],
        sessionTime: 101,
      })
    );

    expect(useMiniSectorStore.getState().classReferenceLaps.size).toBe(0);
  });

  it('should compute gaps when reference lap is available', () => {
    // Setup: 2 cars, same class
    simulateFullLap(0, 1, 100, 1, 2);

    // Finalize lap 1 by starting lap 2
    const store = useMiniSectorStore.getState();
    store.update({
      carIdxLapDistPct: [0.01, 0.5],
      carIdxLap: [2, 1],
      carIdxOnPitRoad: [false, false],
      carIdxTrackSurface: [3, 3],
      carIdxLastLapTime: [100, 0],
      sessionTime: 101,
      sessionNum: 1,
      playerCarIdx: 0,
      carIdxClassId: [1, 1],
      carIdxEstLapTime: [100, 100],
    });

    const state = useMiniSectorStore.getState();
    // Car 1 should have a gap (it's at 0.5, player at 0.01)
    expect(state.gapToPlayer[1]).not.toBe(0);
  });

  it('should keep faster reference lap per class', () => {
    // Simulate car 0 with 100s lap
    simulateFullLap(0, 1, 100, 1, 2);
    useMiniSectorStore.getState().update(
      makeParams({
        carIdxLapDistPct: [0.01, -1],
        carIdxLap: [2, 0],
        carIdxLastLapTime: [100, 0],
        sessionTime: 101,
        carIdxClassId: [1, 1],
        carIdxEstLapTime: [100, 100],
      })
    );

    const firstRef = useMiniSectorStore.getState().classReferenceLaps.get(1);
    expect(firstRef?.lapTime).toBe(100);

    // Simulate car 0 with 95s lap (faster)
    simulateFullLap(0, 2, 95, 1, 2, 101);
    useMiniSectorStore.getState().update(
      makeParams({
        carIdxLapDistPct: [0.01, -1],
        carIdxLap: [3, 0],
        carIdxLastLapTime: [95, 0],
        sessionTime: 197,
        carIdxClassId: [1, 1],
        carIdxEstLapTime: [95, 95],
      })
    );

    const secondRef = useMiniSectorStore.getState().classReferenceLaps.get(1);
    expect(secondRef?.lapTime).toBe(95);
  });
});

// Re-export for test access
const MIN_SECTORS = 180;
