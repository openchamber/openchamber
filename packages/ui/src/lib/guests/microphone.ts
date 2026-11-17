import { GUEST_MICROPHONE_FRAME_MAX, HostRequestError } from '@openchamber/sdk';
import { create } from 'zustand';

export const useGuestListeningStore = create<{ captureCountByGuest: Record<string, number> }>(() => ({
  captureCountByGuest: {},
}));

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
  stop: () => void;
};

type StartOptions = {
  sampleRate: number;
  onSamples: (samples: Float32Array<ArrayBuffer>) => void;
  onDeviceLost: () => void;
};

const BLOCK_SAMPLES = 1024;
const RESUME_WAIT_MS = 2000;

export const canCaptureGuestMicrophone = (): boolean => (
  typeof navigator !== 'undefined'
  && typeof navigator.mediaDevices?.getUserMedia === 'function'
  && typeof globalThis.AudioContext === 'function'
);

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
