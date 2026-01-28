import { useEffect } from 'react';
import {
  useTelemetryValue,
  useTelemetryValues,
  useFocusCarIdx,
  useSessionStore,
} from '@irdashies/context';
import { useMiniSectorStore } from './MiniSectorStore';

/**
 * Hook that feeds telemetry data into the MiniSectorStore each frame.
 *
 * Mount in components that need mini-sector-based gap calculation
 * (e.g., Relative overlay).
 */
export const useMiniSectorStoreUpdater = () => {
  const carIdxLapDistPct = useTelemetryValues('CarIdxLapDistPct');
  const carIdxLap = useTelemetryValues<number[]>('CarIdxLap');
  const carIdxOnPitRoad = useTelemetryValues<boolean[]>('CarIdxOnPitRoad');
  const carIdxTrackSurface = useTelemetryValues<number[]>('CarIdxTrackSurface');
  const carIdxLastLapTime = useTelemetryValues<number[]>('CarIdxLastLapTime');
  const sessionTime = useTelemetryValue('SessionTime');
  const sessionNum = useTelemetryValue('SessionNum');
  const playerCarIdx = useFocusCarIdx();
  const drivers = useSessionStore(
    (s) => s.session?.DriverInfo?.Drivers
  );

  const update = useMiniSectorStore((state) => state.update);

  useEffect(() => {
    if (!carIdxLapDistPct?.length) return;

    // Build flat class ID and estimated lap time arrays from session drivers
    const numCars = carIdxLapDistPct.length;
    const carIdxClassId = new Array<number>(numCars).fill(0);
    const carIdxEstLapTime = new Array<number>(numCars).fill(0);

    if (drivers) {
      for (const driver of drivers) {
        const idx = driver.CarIdx;
        if (idx >= 0 && idx < numCars) {
          carIdxClassId[idx] = driver.CarClassID;
          carIdxEstLapTime[idx] = driver.CarClassEstLapTime;
        }
      }
    }

    update({
      carIdxLapDistPct,
      carIdxLap: carIdxLap ?? [],
      carIdxOnPitRoad: (carIdxOnPitRoad ?? []) as boolean[],
      carIdxTrackSurface: (carIdxTrackSurface ?? []) as number[],
      carIdxLastLapTime: (carIdxLastLapTime ?? []) as number[],
      sessionTime: sessionTime ?? 0,
      sessionNum: sessionNum ?? 0,
      playerCarIdx: playerCarIdx ?? 0,
      carIdxClassId,
      carIdxEstLapTime,
    });
  }, [
    carIdxLapDistPct,
    carIdxLap,
    carIdxOnPitRoad,
    carIdxTrackSurface,
    carIdxLastLapTime,
    sessionTime,
    sessionNum,
    playerCarIdx,
    drivers,
    update,
  ]);
};
