/**
 * The `microphone` capability. A guest frame is sandboxed without
 * `allow-same-origin`, and browsers refuse `getUserMedia` to an opaque origin
 * before any prompt, so the host captures the microphone and posts mono
 * Float32 samples to the frame. `connectHost().openMicrophone()` plays them
 * into a `MediaStream` inside the frame, which a call or a recorder uses like
 * one from `getUserMedia`.
 */

export const GUEST_MICROPHONE_SAMPLE_RATE_MIN = 8_000;
export const GUEST_MICROPHONE_SAMPLE_RATE_MAX = 192_000;
/** How long `openMicrophone` waits: the host may be showing the system's permission prompt. */
export const GUEST_MICROPHONE_OPEN_TIMEOUT_MS = 120_000;
/** Samples in one `microphone-audio` push. */
export const GUEST_MICROPHONE_FRAME_MAX = 16_384;

/**
 * Why the host stopped sending audio: the user withdrew the grant or paused
 * the extension (`revoked`), or the input device went away (`device-lost`).
 */
export const GUEST_MICROPHONE_END_REASONS = ['revoked', 'device-lost'] as const;
export type GuestMicrophoneEndReason = (typeof GUEST_MICROPHONE_END_REASONS)[number];

/** The rate the frame's audio graph runs at; the host captures at the same rate. */
export type MicrophoneOpenRequest = { sampleRate: number };
export type MicrophoneOpenResult = { opened: true };

export type GuestMicrophone = {
  /** One mono audio track carrying the user's microphone. */
  stream: MediaStream;
  /** Stops the capture on the host and ends the track. Safe to call twice. */
  close: () => void;
  /** The host stopped the capture on its own. The handle is closed by then. */
  onEnded: (listener: (reason: GuestMicrophoneEndReason) => void) => () => void;
};

/**
 * Samples waiting to be played into the frame's stream. Audio arrives in
 * bursts over postMessage, so the queue absorbs jitter; past `capacity`
 * samples it drops the oldest, keeping the delay of a live call bounded.
 */
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
    /** Fills `out` from the queue and pads the rest with silence. */
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
