import { describe, it, expect } from 'vitest';
import {
  predictTideAboveMllw,
  predictWaterLevel,
  tideRange,
  TIDE_EPOCH_MS,
  type TidalConstituent,
  type StationDatums,
} from './tide.ts';

/** A single semidiurnal constituent, so the answer is analytic. */
const M2: TidalConstituent = {
  name: 'M2',
  amplitude: 0.6,
  phaseDeg: 0,
  speedDegPerHour: 28.984104,
};

const datums: StationDatums = { mslAboveMllw: 0.94, source: 'test' };

describe('predictTideAboveMllw', () => {
  it('is at the crest at the epoch for a zero-phase constituent', () => {
    expect(predictTideAboveMllw([M2], new Date(TIDE_EPOCH_MS))).toBeCloseTo(0.6, 9);
  });

  it('is at the trough half a period later', () => {
    const halfPeriodMs = (180 / M2.speedDegPerHour) * 3_600_000;
    const v = predictTideAboveMllw([M2], new Date(TIDE_EPOCH_MS + halfPeriodMs));
    expect(v).toBeCloseTo(-0.6, 6);
  });

  it('sums constituents linearly', () => {
    const K1: TidalConstituent = {
      name: 'K1',
      amplitude: 0.35,
      phaseDeg: 0,
      speedDegPerHour: 15.041069,
    };
    const at = new Date(TIDE_EPOCH_MS);
    expect(predictTideAboveMllw([M2, K1], at)).toBeCloseTo(
      predictTideAboveMllw([M2], at) + predictTideAboveMllw([K1], at),
      9,
    );
  });

  it('is flat with no constituents', () => {
    expect(predictTideAboveMllw([], new Date())).toBe(0);
  });

  it('respects phase', () => {
    const shifted: TidalConstituent = { ...M2, phaseDeg: 180 };
    expect(predictTideAboveMllw([shifted], new Date(TIDE_EPOCH_MS))).toBeCloseTo(-0.6, 9);
  });
});

describe('predictWaterLevel', () => {
  /**
   * The correction that matters. NOAA's constants are referenced to mean lower
   * low water, which sits about a metre below mean sea level; leaving it out
   * would put the sea a metre high, the same order as the effect being
   * measured.
   */
  it('shifts from the MLLW reference down to the scene datum', () => {
    const at = new Date(TIDE_EPOCH_MS);
    const aboveMllw = predictTideAboveMllw([M2], at);
    expect(predictWaterLevel([M2], datums, at)).toBeCloseTo(aboveMllw - 0.94, 9);
  });

  it('goes negative at low water, as a level below mean sea level should', () => {
    const halfPeriodMs = (180 / M2.speedDegPerHour) * 3_600_000;
    expect(predictWaterLevel([M2], datums, new Date(TIDE_EPOCH_MS + halfPeriodMs)))
      .toBeLessThan(0);
  });

  it('sits at minus the datum offset when the tide is flat', () => {
    expect(predictWaterLevel([], datums, new Date())).toBeCloseTo(-0.94, 9);
  });
});

describe('tideRange', () => {
  it('recovers twice the amplitude of a single constituent', () => {
    const { min, max } = tideRange([M2], new Date(TIDE_EPOCH_MS), 24, 5);
    expect(max - min).toBeGreaterThan(1.15);
    expect(max - min).toBeLessThanOrEqual(1.2 + 1e-9);
  });

  it('is a single point for a flat tide', () => {
    const { min, max } = tideRange([], new Date(), 24, 60);
    expect(max - min).toBe(0);
  });
});
