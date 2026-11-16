import { GUEST_MICROPHONE_FRAME_MAX, HostRequestError } from '@openchamber/sdk';
import { create } from 'zustand';

/**
 * The host's end of the `microphone` capability: one capture per guest frame.
 * The frame's origin is opaque, so the browser refuses it `getUserMedia`;
 * the host asks for the microphone under its own origin and hands the frame
 * mono samples at the rate the frame's audio graph runs at.
 */

/**
 * Open captures by guest id, so the rail can mark the extension that is
 * listening. The system shows only that the app has the microphone; this
 * says which extension. A guest can listen from more than one frame (its
 * panel and its page), hence a count.
 */
export const useGuestListeningStore = create<{ captureCountByGuest: Record<string, number> }>(() => ({
  captureCountByGuest: {},
}));

/** Counts one capture for `guestId`; the returned release is safe to call twice. */
export const markGuestListening = (guestId: string): (() => void) => {
  const change = (delta: number) => useGuestListeningStore.setState((state) => {
    const count = (state.captureCountByGuest[guestId] ?? 0) + delta;
    const { [guestId]: _previous, ...rest } = state.captureCountByGuest;
    void _previous;
    return { captureCountByGuest: count > 0 ? { ...rest, [guestId]: count } : rest };
  });
  change(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    change(-1);
  };
};

export type GuestMicrophoneCapture = {
  /** Releases the device and the audio graph. Safe to call twice. */
  stop: () => void;
};

type StartOptions = {
  sampleRate: number;
  /** One block of samples, a fresh array the callee may keep. */
  onSamples: (samples: Float32Array<ArrayBuffer>) => void;
  /** The device went away (unplugged, taken by the system); capture has stopped. */
  onDeviceLost: () => void;
};

// About 21 ms at 48 kHz: short enough for a call, long enough that the main
// thread is not woken more than about 50 times a second.
const BLOCK_SAMPLES = 1024;
const RESUME_WAIT_MS = 2000;

export const canCaptureGuestMicrophone = (): boolean => (
  typeof navigator !== 'undefined'
  && typeof navigator.mediaDevices?.getUserMedia === 'function'
  && typeof globalThis.AudioContext === 'function'
);

/** `name` is the DOMException name `getUserMedia` rejected with, or empty. */
const captureError = (name: string): HostRequestError => {
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new HostRequestError('DENIED', 'Microphone access was refused.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new HostRequestError('NOT_FOUND', 'No microphone is connected.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new HostRequestError('HOST_REJECTED', 'The microphone is in use or could not start.');
  }
  return new HostRequestError('HOST_REJECTED', 'The microphone could not start.');
};

export const startGuestMicrophone = async ({ sampleRate, onSamples, onDeviceLost }: StartOptions): Promise<GuestMicrophoneCapture> => {
  if (!canCaptureGuestMicrophone()) {
    throw new HostRequestError('UNSUPPORTED', 'This app cannot capture the microphone.');
  }
  // Echo cancellation and noise suppression suit a call, which is what an
  // extension most often wants a live microphone for.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw captureError(error instanceof DOMException ? error.name : '');
  }

  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate });
  } catch {
    for (const track of stream.getTracks()) track.stop();
    throw new HostRequestError('UNSUPPORTED', `Audio at ${sampleRate} Hz is not supported here.`);
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(BLOCK_SAMPLES, 1, 1);
  // The processor only runs while connected to the output; a muted gain keeps
  // the microphone out of the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    mute.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    onSamples(new Float32Array(input.subarray(0, GUEST_MICROPHONE_FRAME_MAX)));
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (stopped) return;
      stop();
      onDeviceLost();
    });
  }
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  // A context without the user's gesture stays suspended, and its resume()
  // may never settle; no audio would flow while the device is held.
  if (context.state === 'suspended') {
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
    ]);
  }
  if (context.state !== 'running') {
    stop();
    throw new HostRequestError('HOST_REJECTED', 'Audio could not start. Open the microphone from a click.');
  }
  return { stop };
};
