/**
 * The live camera feed, for comparing the render against what is actually
 * there.
 *
 * Three constraints shape this. First, every capability needed here — camera,
 * geolocation, device orientation — requires a secure context, and a plain
 * http:// address on the local network is not one. A phone pointed at a dev
 * server over LAN silently gets nothing, which looks like broken code rather
 * than a policy refusal, so that case is detected and named.
 *
 * Second, device labels are empty strings until permission has been granted.
 * There is therefore no way to offer a considered choice of lens up front: the
 * only honest sequence is to open something, and only then show the user what
 * their phone actually has.
 *
 * Third, iOS Safari does not support the `zoom` constraint, and because every
 * iOS browser is forced onto WKWebView, none of them do. What iOS 16.3 and
 * later does expose is the individual back cameras through enumerateDevices,
 * which is why choosing the lens by name is the mechanism rather than asking
 * for a zoom factor. Older iOS reports one fused "Back Camera" and picks the
 * lens itself, and there is no way to reach the telephoto at all.
 */

export interface CameraDevice {
  deviceId: string;
  /** Empty until camera permission has been granted at least once. */
  label: string;
  /** Whether the label suggests this is a rear-facing lens. */
  back: boolean;
}

export interface OpenCamera {
  stream: MediaStream;
  deviceId: string;
  label: string;
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

function looksBack(label: string): boolean {
  return /back|rear|environment/i.test(label);
}

/** Rank lenses the way they are useful here: rear first, longest first. */
function lensOrder(label: string): number {
  if (/tele/i.test(label)) return 0;
  if (looksBack(label) && !/ultra|wide/i.test(label)) return 1;
  if (/ultra.?wide/i.test(label)) return 2;
  if (looksBack(label)) return 1;
  return 3;
}

function assertUsable(): void {
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
}

/**
 * Every video input the platform will admit to, best lens first.
 *
 * Returns labelled devices only after permission exists. Before that the
 * browser still lists the devices but blanks the labels, which is worse than
 * useless in a menu, so the caller is expected to open a camera first.
 */
export async function listCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const seen = new Set<string>();
  const cameras: CameraDevice[] = [];
  for (const d of devices) {
    if (d.kind !== 'videoinput' || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    cameras.push({ deviceId: d.deviceId, label: d.label, back: looksBack(d.label) });
  }
  return cameras.sort((a, b) => lensOrder(a.label) - lensOrder(b.label));
}

/**
 * Open a camera — a named one if asked for, otherwise whatever faces away.
 *
 * A specific deviceId is honoured exactly, with no silent substitution: the
 * point of the menu is that the user chose that lens, and quietly opening a
 * different one would make every matched frame wrong by an unknown factor.
 */
export async function openCamera(deviceId?: string): Promise<OpenCamera> {
  assertUsable();

  const constraints: MediaStreamConstraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } },
    audio: false,
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraUnavailableError(
        'Camera permission was refused.',
        'Allow camera access for this site and try again.',
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraUnavailableError(
        deviceId ? 'That camera is no longer available.' : 'No camera found.',
        deviceId ? 'Pick another from the list.' : 'Check the device has a rear camera.',
      );
    }
    if (name === 'NotReadableError') {
      throw new CameraUnavailableError(
        'The camera is in use by something else.',
        'Close other apps or tabs using the camera and try again.',
      );
    }
    throw new CameraUnavailableError(
      `Could not open the camera (${name || 'unknown error'}).`,
      'Close other apps using the camera and try again.',
    );
  }

  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() ?? {};
  const notes: string[] = [];

  const cameras = await listCameras();
  if (cameras.length <= 1) {
    notes.push(
      'This browser exposes only one camera. On iOS before 16.3 the back lenses ' +
        'are fused into one device and the telephoto cannot be reached from the web.',
    );
  }

  return {
    stream,
    deviceId: settings.deviceId ?? deviceId ?? '',
    label: track?.label ?? '',
    notes,
  };
}

export function stopCamera(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
