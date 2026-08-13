/**
 * The live camera feed, for comparing the render against what is actually
 * there.
 *
 * Two constraints shape this. First, every capability needed here — camera,
 * and later geolocation and orientation — requires a secure context, and a
 * plain http:// address on the local network is not one. A phone pointed at a
 * dev server over LAN silently gets nothing, which looks like broken code
 * rather than a policy refusal, so that case is detected and named.
 *
 * Second, iOS Safari does not support the `zoom` constraint, and because every
 * iOS browser is forced onto WKWebView, none of them do. What iOS 16.3 and
 * later does expose is the individual back cameras through enumerateDevices,
 * so the telephoto is selected by device rather than by zoom factor. Beyond
 * the longest optical lens, "zoom" is only cropping and adds no resolution, so
 * there is nothing lost by not having the constraint.
 */

export interface CameraStart {
  stream: MediaStream;
  /** Label of the chosen device, empty before permission is granted. */
  label: string;
  /** True when a lens whose label looks telephoto was selected. */
  telephoto: boolean;
  notes: string[];
}

export class CameraUnavailableError extends Error {
  constructor(
    message: string,
    /** Something the user can act on, rather than a bare failure. */
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'CameraUnavailableError';
  }
}

function looksTelephoto(label: string): boolean {
  return /tele/i.test(label);
}

/**
 * Open the back camera, preferring a telephoto lens if the platform names one.
 *
 * Labels are empty until permission has been granted, so this opens a stream
 * first and only then re-enumerates to look for a longer lens — there is no
 * way to choose well before the user has said yes.
 */
export async function startCamera(): Promise<CameraStart> {
  if (!globalThis.isSecureContext) {
    throw new CameraUnavailableError(
      'The camera needs a secure context.',
      'Open this page over HTTPS, or on localhost. A LAN address like ' +
        'http://192.168.x.x will not do — the browser refuses silently.',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraUnavailableError(
      'This browser exposes no camera API.',
      'Try a current Safari, Chrome or Firefox.',
    );
  }

  const notes: string[] = [];
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') {
      throw new CameraUnavailableError(
        'Camera permission was refused.',
        'Allow camera access for this site and try again.',
      );
    }
    if (name === 'NotFoundError') {
      throw new CameraUnavailableError('No camera found.', 'Check the device has a rear camera.');
    }
    throw new CameraUnavailableError(
      `Could not open the camera (${name || 'unknown error'}).`,
      'Close other apps using the camera and try again.',
    );
  }

  let label = stream.getVideoTracks()[0]?.label ?? '';

  // Now that permission exists, labels are populated and a longer lens may be
  // nameable. iOS 16.3+ lists the back cameras individually.
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'videoinput',
  );
  const tele = cameras.find((d) => looksTelephoto(d.label));

  if (tele && !looksTelephoto(label)) {
    try {
      const better = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: tele.deviceId } },
        audio: false,
      });
      for (const t of stream.getTracks()) t.stop();
      stream = better;
      label = better.getVideoTracks()[0]?.label ?? tele.label;
    } catch {
      notes.push(`A telephoto lens is listed (${tele.label}) but could not be opened.`);
    }
  } else if (!tele) {
    notes.push(
      'No telephoto lens is exposed. At a wide focal length the curvature signal ' +
        'lands on a couple of pixels — import a long-lens photograph for measurement.',
    );
  }

  return { stream, label, telephoto: looksTelephoto(label), notes };
}

export function stopCamera(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
