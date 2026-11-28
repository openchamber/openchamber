import type { HostMicrophoneAudioMessage, HostMicrophoneEndedMessage, HostResultPayload } from './contract.ts';
import { HostRequestError } from './errors.ts';

// external: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security An opaque-origin iframe cannot call getUserMedia, so the host captures audio.

export const GUEST_MICROPHONE_SAMPLE_RATE_MIN = 8_000;
export const GUEST_MICROPHONE_SAMPLE_RATE_MAX = 192_000;
export const GUEST_MICROPHONE_OPEN_TIMEOUT_MS = 120_000;
export const GUEST_MICROPHONE_FRAME_MAX = 16_384;

export const GUEST_MICROPHONE_END_REASONS = ['revoked', 'device-lost'] as const;
export type GuestMicrophoneEndReason = (typeof GUEST_MICROPHONE_END_REASONS)[number];

export type MicrophoneOpenRequest = { sampleRate: number };
export type MicrophoneOpenResult = { opened: true };

export type GuestMicrophone = {
  stream: MediaStream;
  close: () => void;
  onEnded: (listener: (reason: GuestMicrophoneEndReason) => void) => () => void;
};

export const createSampleQueue = (capacity: number) => {
  const chunks: Float32Array[] = [];
  let offset = 0;
  let queued = 0;
  return {
    push: (samples: Float32Array): void => {
      chunks.push(samples);
      queued += samples.length;
      while (queued - offset > capacity && chunks.length > 1) {
        const dropped = chunks.shift();
        queued -= dropped?.length ?? 0;
        offset = 0;
      }
    },
    pull: (out: Float32Array): void => {
      let written = 0;
      while (written < out.length && chunks.length > 0) {
        const head = chunks[0];
        const count = Math.min(out.length - written, head.length - offset);
        out.set(head.subarray(offset, offset + count), written);
        written += count;
        offset += count;
        if (offset >= head.length) {
          chunks.shift();
          queued -= head.length;
          offset = 0;
        }
      }
      out.fill(0, written);
    },
    clear: (): void => {
      chunks.length = 0;
      offset = 0;
      queued = 0;
    },
    get size(): number {
      return queued - offset;
    },
  };
};

type GuestMicrophoneHost = {
  open: () => Promise<GuestMicrophone>;
  handleMessage: (message: HostMicrophoneAudioMessage | HostMicrophoneEndedMessage) => void;
  release: () => void;
};

export const createGuestMicrophoneHost = ({
  isEnabled,
  envelope,
  nextId,
  send,
  postClose,
}: {
  isEnabled: () => boolean;
  envelope: Pick<HostMicrophoneAudioMessage, 'channel' | 'v'>;
  nextId: () => string;
  send: (message: Pick<HostMicrophoneAudioMessage, 'channel' | 'v'> & { type: 'microphone-open'; id: string; payload: { sampleRate: number } }, timeoutMs: number) => Promise<HostResultPayload | undefined>;
  postClose: () => void;
}): GuestMicrophoneHost => {
  let microphone: {
    queue: ReturnType<typeof createSampleQueue>;
    endedListeners: Set<(reason: GuestMicrophoneEndReason) => void>;
    release: () => void;
  } | null = null;

  const open = async (): Promise<GuestMicrophone> => {
    if (microphone) throw new HostRequestError('HOST_REJECTED', 'The microphone is already open in this frame.');
    if (!isEnabled()) {
      throw new HostRequestError('UNSUPPORTED', 'This OpenChamber cannot share the microphone with extensions.');
    }
    const AudioContextCtor = globalThis.AudioContext;
    if (!(AudioContextCtor instanceof Function)) throw new HostRequestError('UNSUPPORTED', 'This frame has no Web Audio.');
    const context = new AudioContextCtor();
    if (context.sampleRate < GUEST_MICROPHONE_SAMPLE_RATE_MIN || context.sampleRate > GUEST_MICROPHONE_SAMPLE_RATE_MAX) {
      void context.close().catch(() => undefined);
      throw new HostRequestError('UNSUPPORTED', `Audio at ${context.sampleRate} Hz is not supported.`);
    }
    const resumed = context.state === 'suspended' ? context.resume().catch(() => undefined) : undefined;
    const queue = createSampleQueue(Math.round(context.sampleRate / 4));
    const processor = context.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (event) => queue.pull(event.outputBuffer.getChannelData(0));
    const destination = context.createMediaStreamDestination();
    processor.connect(destination);
    const endedListeners = new Set<(reason: GuestMicrophoneEndReason) => void>();
    const open = {
      queue,
      endedListeners,
      release: () => {
        processor.onaudioprocess = null;
        processor.disconnect();
        queue.clear();
        for (const track of destination.stream.getTracks()) track.stop();
        void context.close().catch(() => undefined);
      },
    };
    microphone = open;
    try {
      const result = await send({ ...envelope, type: 'microphone-open', id: nextId(), payload: { sampleRate: context.sampleRate } }, GUEST_MICROPHONE_OPEN_TIMEOUT_MS);
      if (!result || !('opened' in result) || result.opened !== true) {
        throw new HostRequestError('HOST_REJECTED', 'Host did not open the microphone.');
      }
      await resumed;
      if (microphone !== open) throw new HostRequestError('DISCONNECTED', 'The microphone closed while it was opening.');
    } catch (error) {
      if (microphone === open) microphone = null;
      open.release();
      postClose();
      throw error;
    }
    return {
      stream: destination.stream,
      close: () => {
        if (microphone !== open) return;
        microphone = null;
        open.release();
        postClose();
      },
      onEnded: (listener) => {
        endedListeners.add(listener);
        return () => { endedListeners.delete(listener); };
      },
    };
  };

  const handleMessage: GuestMicrophoneHost['handleMessage'] = (message) => {
    if (message.type === 'microphone-audio') {
      microphone?.queue.push(message.payload.samples);
      return;
    }
    const open = microphone;
    if (!open) return;
    microphone = null;
    open.release();
    for (const listener of open.endedListeners) {
      try {
        listener(message.payload.reason);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const release = (): void => {
    if (!microphone) return;
    postClose();
    microphone.release();
    microphone = null;
  };

  return { open, handleMessage, release };
};
