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

import type { Provenance, TideProvider, TideStation } from './types.ts';
import type { TidalConstituent } from '../../core/tide.ts';
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

interface DatumsResponse {
  datums?: { name: string; value: number }[];
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

      // Harmonic constants are referenced to MLLW; the scene works in a
      // geoid-based datum, so without this offset the predicted level is about
      // a metre out — the same order as the effect being measured.
      const datums = await this.getJson<DatumsResponse>(
        `${MDAPI}/${id}/datums.json?units=metric`,
      );
      const find = (n: string): number | undefined =>
        datums.datums?.find((d) => d.name.toUpperCase() === n)?.value;
      const mllw = find('MLLW');
      const msl = find('MSL');
      if (mllw === undefined || msl === undefined) {
        throw new ProviderUnavailableError(
          this.id,
          `station ${id} did not publish both MLLW and MSL datums`,
        );
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
        datums: {
          mslAboveMllw: msl - mllw,
          source: `NOAA CO-OPS published datums for station ${id} (MSL - MLLW)`,
        },
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
          'Constituents are referenced to MLLW; each station carries its published ' +
            'MSL-above-MLLW offset so levels can be expressed in the scene datum.',
          'Mean sea level is taken as the scene datum. MSL departs from the geoid by ocean ' +
            'dynamic topography, of order a decimetre locally — small against the tide range ' +
            'it corrects for, but an assumption.',
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
