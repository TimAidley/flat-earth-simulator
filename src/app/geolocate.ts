/**
 * Standing where you are actually standing.
 *
 * The horizontal fix is used and the vertical one is thrown away, which looks
 * wasteful until you compare the errors. GPS altitude is frequently absent on
 * Android and, where present, carries ten to twenty metres of error — several
 * times the four to eight metres of hidden height that the whole exercise
 * exists to see. Feeding it in would swamp the signal with the instrument.
 *
 * Horizontal error is harmless by comparison: five metres of lateral slop
 * changes a thirteen-kilometre sightline by five metres in range, which moves
 * the hidden height by under a millimetre. So the position comes from the
 * satellite and the height comes from the terrain grid, sampled at that
 * position, plus a stated eye height.
 */

export interface Fix {
  lat: number;
  lon: number;
  /** Horizontal accuracy, metres, at 95% confidence. */
  accuracyM: number;
  at: Date;
}

export class GeolocationUnavailableError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'GeolocationUnavailableError';
  }
}

function describe(err: GeolocationPositionError): GeolocationUnavailableError {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return new GeolocationUnavailableError(
        'Location permission was refused.',
        'Allow location access for this site, then try again.',
      );
    case err.POSITION_UNAVAILABLE:
      return new GeolocationUnavailableError(
        'No position fix.',
        'Under open sky this usually clears in a few seconds.',
      );
    case err.TIMEOUT:
      return new GeolocationUnavailableError(
        'Timed out waiting for a fix.',
        'Try again with a clear view of the sky.',
      );
    default:
      return new GeolocationUnavailableError(err.message || 'Location failed.', 'Try again.');
  }
}

/**
 * Follow the device's position until the returned function is called.
 *
 * `watchPosition` rather than `getCurrentPosition` because the first fix is
 * usually the coarse network one and the satellite fix arrives seconds later;
 * a one-shot read tends to return the worse of the two.
 */
export function watchLocation(
  onFix: (fix: Fix) => void,
  onError: (err: GeolocationUnavailableError) => void,
): () => void {
  if (!globalThis.isSecureContext) {
    onError(
      new GeolocationUnavailableError(
        'Location needs a secure context.',
        'Open this page over HTTPS, or on localhost.',
      ),
    );
    return () => {};
  }
  if (!navigator.geolocation) {
    onError(
      new GeolocationUnavailableError(
        'This browser exposes no location API.',
        'Try a current Safari, Chrome or Firefox.',
      ),
    );
    return () => {};
  }

  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onFix({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
        at: new Date(pos.timestamp),
      });
    },
    (err) => onError(describe(err)),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 2_000 },
  );

  return () => navigator.geolocation.clearWatch(id);
}

export interface BBoxLike {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/** Whether a fix falls inside the region this bundle has terrain for. */
export function insideBBox(fix: { lat: number; lon: number }, bbox: BBoxLike): boolean {
  return (
    fix.lat >= bbox.latMin &&
    fix.lat <= bbox.latMax &&
    fix.lon >= bbox.lonMin &&
    fix.lon <= bbox.lonMax
  );
}
