/**
 * Letting the phone's own sense of where it points drive the render.
 *
 * Worth being clear about what this can and cannot do. Pitch and roll come
 * from the accelerometer fused with the rate gyro and are good to about a
 * degree. Heading needs the magnetometer, and that is good to perhaps two to
 * five degrees — worse beside a car, a steel railing, or a case with a magnet
 * in it. A 300 mm frame is 6.9 degrees wide and a 600 mm frame is 3.4, so an
 * absolute heading from this sensor cannot put a landmark where you want it.
 *
 * So it is used as a tracker, not as an aim. The user drags a landmark into
 * place once; the offset between the sensor's heading and the true one is
 * captured at that moment and held, and from then on the phone's motion moves
 * the render while the offset absorbs everything the compass gets wrong. Drift
 * over a minute is small, and re-aligning is one drag.
 *
 * Three platform facts drive the shape of the code. iOS requires
 * `requestPermission()` from inside a user gesture. iOS reports a true-north
 * heading in the non-standard `webkitCompassHeading` and never fires
 * `deviceorientationabsolute`. Chrome for Android fires
 * `deviceorientationabsolute` with alpha referenced to *magnetic* north and
 * leaves the declination to the caller.
 */

import { attitudeFromDeviceOrientation, type Attitude } from '../core/attitude.ts';

/** What the reported heading is measured against, which decides how far to trust it. */
export type HeadingReference =
  /** iOS compass: already corrected to true north. */
  | 'true'
  /** Earth-referenced but magnetic; the scene's declination has been added. */
  | 'magnetic'
  /** No absolute reference at all. Usable for tracking, meaningless as a bearing. */
  | 'relative';

export interface OrientationReading extends Attitude {
  headingReference: HeadingReference;
}

export class OrientationUnavailableError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'OrientationUnavailableError';
  }
}

/** iOS puts the permission gate on the constructor, which is not in the DOM types. */
interface IosDeviceOrientationEventConstructor {
  requestPermission?: () => Promise<'granted' | 'denied' | 'prompt'>;
}

/** Safari's non-standard true-north heading, likewise absent from the DOM types. */
interface IosDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  /** Negative when the magnetometer is uncalibrated, and then the heading is a lie. */
  webkitCompassAccuracy?: number;
}

export interface OrientationHandle {
  stop: () => void;
  headingReference: HeadingReference;
  notes: string[];
}

/**
 * How far the picture is turned from the device's natural orientation.
 *
 * `window.orientation` is the fallback for iOS before 16.4 and uses the
 * opposite sign, so it is negated rather than passed through — which is the
 * difference between a landscape frame that matches and one lying on its side.
 */
function screenAngle(): number {
  const angle = screen.orientation?.angle;
  if (typeof angle === 'number') return angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? ((-legacy % 360) + 360) % 360 : 0;
}

/**
 * Start following the device's attitude. Must be called from a user gesture:
 * iOS refuses the permission prompt otherwise, and does so silently.
 *
 * Resolves once a reading has actually arrived, so a toggle wired to this
 * either works or explains why not, rather than sitting on quietly doing
 * nothing — which is what a desktop browser with no sensors would otherwise do.
 */
export async function startOrientation(
  options: { declinationDeg: number },
  onReading: (reading: OrientationReading) => void,
): Promise<OrientationHandle> {
  if (!globalThis.isSecureContext) {
    throw new OrientationUnavailableError(
      'Motion sensors need a secure context.',
      'Open this page over HTTPS, or on localhost.',
    );
  }
  if (typeof DeviceOrientationEvent === 'undefined') {
    throw new OrientationUnavailableError(
      'This browser exposes no orientation sensors.',
      'Aim by dragging instead.',
    );
  }

  const notes: string[] = [];

  const ctor = DeviceOrientationEvent as unknown as IosDeviceOrientationEventConstructor;
  if (typeof ctor.requestPermission === 'function') {
    let verdict: 'granted' | 'denied' | 'prompt';
    try {
      verdict = await ctor.requestPermission();
    } catch {
      throw new OrientationUnavailableError(
        'The motion sensor prompt was refused.',
        'iOS only allows it straight from a tap. Tap the gyro switch again.',
      );
    }
    if (verdict !== 'granted') {
      throw new OrientationUnavailableError(
        'Motion sensor permission was refused.',
        'Enable Motion & Orientation Access in Settings > Apps > Safari, then reload.',
      );
    }
  }

  // Absolute events carry an Earth reference; plain ones may not. iOS fires
  // only the plain event but supplies a compass heading on it.
  const absoluteAvailable = 'ondeviceorientationabsolute' in window;
  const eventName = absoluteAvailable ? 'deviceorientationabsolute' : 'deviceorientation';

  let headingReference: HeadingReference = 'relative';
  let sawReading = false;
  let resolveFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  const handler = (event: Event): void => {
    const e = event as IosDeviceOrientationEvent;
    if (e.alpha === null && e.beta === null && e.gamma === null) return;

    let alpha = e.alpha ?? 0;
    const compass = e.webkitCompassHeading;
    const compassUsable =
      typeof compass === 'number' &&
      Number.isFinite(compass) &&
      (e.webkitCompassAccuracy === undefined || e.webkitCompassAccuracy >= 0);

    if (compassUsable) {
      // Safari reports the heading of the device's top edge, already corrected
      // to true north. Alpha runs the other way, so it is reconstructed rather
      // than the whole attitude being computed twice.
      alpha = 360 - compass;
      headingReference = 'true';
    } else if (absoluteAvailable || e.absolute) {
      headingReference = 'magnetic';
    } else {
      headingReference = 'relative';
    }

    const attitude = attitudeFromDeviceOrientation({
      alpha,
      beta: e.beta ?? 0,
      gamma: e.gamma ?? 0,
      screenAngle: screenAngle(),
    });

    // Chrome leaves alpha on magnetic north; the scene knows the local
    // declination, which is a good deal larger than the sensor's own error.
    if (headingReference === 'magnetic') {
      attitude.bearingDeg = ((attitude.bearingDeg + options.declinationDeg) % 360 + 360) % 360;
    }

    if (!sawReading) {
      sawReading = true;
      resolveFirst?.();
    }
    onReading({ ...attitude, headingReference });
  };

  window.addEventListener(eventName, handler);
  const stop = (): void => window.removeEventListener(eventName, handler);

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new OrientationUnavailableError(
          'The orientation sensors reported nothing.',
          'Desktop browsers usually have none. Aim by dragging instead.',
        ),
      );
    }, 2000);
  });

  try {
    await Promise.race([first, timeout]);
  } catch (err) {
    stop();
    throw err;
  }

  if (headingReference === 'relative') {
    notes.push(
      'No absolute compass reference here, so the heading is arbitrary. ' +
        'Aim once by dragging; tracking from there still works.',
    );
  } else if (headingReference === 'magnetic') {
    notes.push(
      `Heading is magnetic, corrected by ${options.declinationDeg.toFixed(1)}° of declination.`,
    );
  }
  notes.push('Compass heading is good to a few degrees at best — drag to align, then let it track.');

  return { stop, headingReference, notes };
}
