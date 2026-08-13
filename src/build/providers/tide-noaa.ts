/**
 * Tidal harmonic constituents from NOAA CO-OPS.
 *
 * Baking constituents rather than a prediction series is what makes tide work
 * offline: the shoreline has patchy signal, predictions expire, constituents
 * do not. And tide is not a detail here — the Bay's diurnal range is around
 * 1.8 m, comparable to the entire curvature effect being measured at these
 * distances, so it is a first-order correction on the target's waterline.
 *
 * Note the range does *not* simply cancel. An observer standing at the water's
 * edge has a tide-invariant eye height above the water, but the San Francisco
 * seawall is vertical, so the target's visible base still moves with the tide.
 *
 * NOAA is US-only. Going global means FES2022 via PyFES or TPXO; the interface
 * is shaped so that is a new provider rather than a change here.
 *
 * ## Not exercised in the development sandbox
 *
 * api.tidesandcurrents.noaa.gov is blocked by the sandbox network policy
 * (HTTP 403 at the proxy), so this path is written to NOAA's documented mdapi
 * schema but has not been run against the live service here.
 */

import type { Provenance, TideProvider, TideStation, TidalConstituent } from './types.ts';
import { ProviderUnavailableError } from './types.ts';

const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';

interface HarconResponse {
  HarmonicConstituents?: {
    name: string;
    amplitude: number;
    phase_GMT: number;
    speed: number;
  }[];
}

interface StationResponse {
  stations?: { id: string; name: string; lat: number; lng: number }[];
}

export class NoaaTideProvider implements TideProvider {
  readonly id = 'noaa-harcon';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetch(
    stationIds: string[],
  ): Promise<{ stations: TideStation[]; provenance: Provenance }> {
    const stations: TideStation[] = [];

    for (const id of stationIds) {
      const meta = await this.getJson<StationResponse>(`${MDAPI}/${id}.json`);
      const info = meta.stations?.[0];
      if (!info) {
        throw new ProviderUnavailableError(this.id, `station ${id} returned no metadata`);
      }

      const harcon = await this.getJson<HarconResponse>(
        `${MDAPI}/${id}/harcon.json?units=metric`,
      );
      const constituents: TidalConstituent[] = (harcon.HarmonicConstituents ?? []).map(
        (c) => ({
          name: c.name,
          amplitude: c.amplitude,
          phaseDeg: c.phase_GMT,
          speedDegPerHour: c.speed,
        }),
      );

      if (constituents.length === 0) {
        throw new ProviderUnavailableError(
          this.id,
          `station ${id} returned no harmonic constituents`,
        );
      }

      stations.push({
        id,
        name: info.name,
        lat: info.lat,
        lon: info.lng,
        // NOAA harmonic constants are referenced to MLLW at the station.
        datum: 'mllw',
        constituents,
      });
    }

    return {
      stations,
      provenance: {
        source: 'NOAA CO-OPS harmonic constituents',
        url: 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/',
        licence: 'US Government work, public domain',
        retrievedAt: new Date().toISOString(),
        datum: 'mllw',
        verified: true,
        notes: [
          `${stations.length} stations: ${stations.map((s) => `${s.id} (${s.name})`).join(', ')}.`,
          'Constituents are referenced to MLLW at each station; converting to the scene ' +
            'datum needs the station\'s published MLLW-to-datum offset.',
        ],
      },
    };
  }

  private async getJson<T>(url: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (cause) {
      throw new ProviderUnavailableError(this.id, `could not reach ${url}`, cause);
    }
    if (!res.ok) {
      throw new ProviderUnavailableError(this.id, `HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Predict water level at a time from harmonic constituents, metres above the
 * station's datum.
 *
 * This is the plain harmonic sum without nodal corrections, which are a
 * sub-decimetre effect on an 18.6-year cycle. That is below the noise floor of
 * everything else in this pipeline, but it is an approximation and is recorded
 * as one.
 */
export function predictTide(station: TideStation, at: Date): number {
  // Hours from the epoch NOAA phases are referenced to (GMT, start of 1983).
  const epoch = Date.UTC(1983, 0, 1, 0, 0, 0);
  const hours = (at.getTime() - epoch) / 3_600_000;

  let level = 0;
  for (const c of station.constituents) {
    const angle = ((c.speedDegPerHour * hours - c.phaseDeg) * Math.PI) / 180;
    level += c.amplitude * Math.cos(angle);
  }
  return level;
}
