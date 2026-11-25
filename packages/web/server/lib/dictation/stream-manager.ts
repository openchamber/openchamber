
import {
  Pcm16MonoResampler,
  parsePcmRateFromFormat,
  pcm16leFrameRms,
  pcm16lePeakAbs,
} from './audio.js';
import { resumeOptionsOf, sameResumeOptions } from './stream-resume-options.js';
import { CORRECTION_TIMEOUT_MS } from './transcript-correction.js';
import type { CorrectionOptions } from './transcript-correction.js';

export interface DictationStartOptions {
  provider?: unknown;
  language?: unknown;
  localModel?: unknown;
  openaiCompatible?: unknown;
  correct?: unknown;
}

export interface StreamingTranscriptionSession {
  requiredSampleRate: number;
  appendPcm16: (audio: Buffer) => void;
  commit: () => void;
  clear: () => void;
  close: () => void;
  on(event: 'committed', listener: (payload: { segmentId: unknown }) => void): void;
  on(event: 'transcript', listener: (payload: {
    segmentId: unknown;
    transcript: unknown;
    isFinal: unknown;
  }) => void): void;
  on(event: 'error', listener: (cause: unknown) => void): void;
}

export interface DictationSessionResult {
  session?: StreamingTranscriptionSession;
  error?: unknown;
  retryable?: boolean;
  reasonCode?: string;
}

export type DictationStreamMessage =
  | { type: 'ack'; payload: { dictationId: string; ackSeq: number } }
  | { type: 'partial' | 'final'; payload: { dictationId: string; text: string } }
  | { type: 'finish_accepted'; payload: { dictationId: string; timeoutMs: number } }
  | { type: 'error'; payload: {
    dictationId: string;
    error: unknown;
    retryable: boolean;
    reasonCode?: string;
  } };

export interface DictationStreamManagerOptions {
  emit: (message: DictationStreamMessage) => void;
  createSttSession: (options: DictationStartOptions) => Promise<DictationSessionResult | null | undefined>;
  correctTranscript?: (text: string, options: CorrectionOptions) => Promise<string>;
  finalTimeoutMs?: number;
  segmentMinSeconds?: number;
  segmentMaxSeconds?: number;
  idleReleaseMs?: number;
}

export interface DictationStreamState {
  dictationId: string;
  inputFormat: string;
  resumeOptions: ReturnType<typeof resumeOptionsOf>;
  stt: StreamingTranscriptionSession;
  inputRate: number;
  outputRate: number;
  resampler: Pcm16MonoResampler | null;
  receivedChunks: Map<number, Buffer>;
  nextSeqToForward: number;
  ackSeq: number;
  segmentMinBytes: number;
  segmentMaxBytes: number;
  pauseFrameSamples: number;
  recentChunkFloors: number[];
  loudestRms: number;
  quietRunFrames: number;
  bytesSinceCommit: number;
  peakSinceCommit: number;
  committedSegmentIds: unknown[];
  transcriptsBySegmentId: Map<unknown, unknown>;
  finalTranscriptSegmentIds: Set<unknown>;
  pendingCommits: number;
  pendingCommitBytes: number[];
  pendingAudioBySegmentId: Map<unknown, number>;
  finishRequested: boolean;
  finishSealed: boolean;
  finalSeq: number | null;
  finalTimeout: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout>;
  correction: CorrectionOptions | null;
  correcting: boolean;
}

function hasMessage(value: unknown): value is { message?: unknown } {
  return value !== null && value !== undefined;
}

const DEFAULT_FINAL_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_RELEASE_MS = 5 * 60 * 1000;
const STREAM_RELEASED = 'stream_released';
const DEFAULT_SEGMENT_MIN_SECONDS = 15;
const DEFAULT_SEGMENT_MAX_SECONDS = 25;
const OPENAI_SEGMENT_MIN_SECONDS = 60;
const OPENAI_SEGMENT_MAX_SECONDS = 120;
const FINAL_TIMEOUT_MAX_MS = 5 * 60 * 1000;
const FINAL_TIMEOUT_PER_PENDING_SEGMENT_MS = 15 * 1000;
const FINAL_TIMEOUT_PER_PENDING_AUDIO_SECOND_MS = 1500;
const FINAL_TIMEOUT_PER_MISSING_SEQ_MS = 250;
const SILENCE_PEAK_THRESHOLD = 300;
const PAUSE_FRAME_MS = 50;
const PAUSE_MIN_FRAMES = 4;
const NOISE_FLOOR_WINDOW_CHUNKS = 10;
const QUIET_ABOVE_FLOOR_RATIO = 3;
const QUIET_BELOW_SPEECH_RATIO = 6;
const QUIET_RMS_MIN = 200;

const secondsToPcm16Bytes = (seconds: number, sampleRate: number) =>
  seconds > 0 ? Math.max(1, Math.round(seconds * sampleRate * 2)) : 0;

function findSegmentCut(state: DictationStreamState, pcm16: Buffer) {
  if (state.finishRequested) {
    return null;
  }
  const capReached =
    state.segmentMaxBytes > 0 && state.bytesSinceCommit + pcm16.length >= state.segmentMaxBytes;
  const frameSamples = state.pauseFrameSamples;
  const frameBytes = frameSamples * 2;
  const rms = pcm16leFrameRms(pcm16, frameSamples);
  if (rms.length === 0) {
    return capReached ? pcm16.length : null;
  }

  let chunkFloor = Infinity;
  for (const value of rms) {
    if (value < chunkFloor) {
      chunkFloor = value;
    }
    if (value > state.loudestRms) {
      state.loudestRms = value;
    }
  }
  state.recentChunkFloors.push(chunkFloor);
  if (state.recentChunkFloors.length > NOISE_FLOOR_WINDOW_CHUNKS) {
    state.recentChunkFloors.shift();
  }
  const noiseFloor = Math.min(...state.recentChunkFloors);
  const quietBelow = Math.min(
    Math.max(noiseFloor * QUIET_ABOVE_FLOOR_RATIO, QUIET_RMS_MIN),
    state.loudestRms / QUIET_BELOW_SPEECH_RATIO,
  );
  const quiet = rms.map((value) => value <= quietBelow);

  let cut = null;
  if (state.segmentMinBytes > 0) {
    let runStart = -state.quietRunFrames;
    let inRun = state.quietRunFrames > 0;
    for (let i = 0; i <= quiet.length; i += 1) {
      if (i < quiet.length && quiet[i]) {
        if (!inRun) {
          inRun = true;
          runStart = i;
        }
        continue;
      }
      if (!inRun) {
        continue;
      }
      inRun = false;
      if (i - runStart < PAUSE_MIN_FRAMES) {
        continue;
      }
      const bytes = Math.max(0, Math.floor((runStart + i) / 2)) * frameBytes;
      if (state.bytesSinceCommit + bytes >= state.segmentMinBytes) {
        cut = bytes;
        break;
      }
    }
  }

  if (cut === null && capReached) {
    let quietest = 0;
    for (let i = 1; i < rms.length; i += 1) {
      if ((rms[i] ?? NaN) < (rms[quietest] ?? NaN)) {
        quietest = i;
      }
    }
    cut = (quietest * frameSamples + (frameSamples >> 1)) * 2;
  }

  let trailing = 0;
  while (trailing < quiet.length && quiet[quiet.length - 1 - trailing]) {
    trailing += 1;
  }
  state.quietRunFrames = trailing;
  return cut;
}

export class DictationStreamManager {
  declare emit: DictationStreamManagerOptions['emit'];
  declare createSttSession: DictationStreamManagerOptions['createSttSession'];
  declare correctTranscript: NonNullable<DictationStreamManagerOptions['correctTranscript']> | null;
  declare finalTimeoutMs: number;
  declare segmentMinSeconds: number | undefined;
  declare segmentMaxSeconds: number | undefined;
  declare idleReleaseMs: number;
  declare streams: Map<string, DictationStreamState>;
  declare starting: Map<string, { format: string; resumeOptions: ReturnType<typeof resumeOptionsOf> }>;

  constructor({ emit, createSttSession, correctTranscript, finalTimeoutMs, segmentMinSeconds, segmentMaxSeconds, idleReleaseMs }: DictationStreamManagerOptions) {
    this.emit = emit;
    this.createSttSession = createSttSession;
    this.correctTranscript = correctTranscript ?? null;
    this.finalTimeoutMs = finalTimeoutMs ?? DEFAULT_FINAL_TIMEOUT_MS;
    this.segmentMinSeconds = segmentMinSeconds;
    this.segmentMaxSeconds = segmentMaxSeconds;
    this.idleReleaseMs = idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this.streams = new Map();
    this.starting = new Map();
  }

  cleanupAll() {
    for (const dictationId of new Set([...this.streams.keys(), ...this.starting.keys()])) {
      this.cleanupStream(dictationId);
    }
  }

  resumeStream(dictationId: string, format: string, startOptions: DictationStartOptions) {
    const state = this.streams.get(dictationId);
    if (!state) {
      return false;
    }
    if (state.inputFormat !== format) {
      return false;
    }
    if (!sameResumeOptions(state.resumeOptions, resumeOptionsOf(startOptions))) {
      return false;
    }
    state.idleTimer.refresh();
    this.emitAck(dictationId, state.ackSeq);
    return true;
  }

  async handleStart(dictationId: string, format: string, startOptions: DictationStartOptions = {}) {
    if (this.resumeStream(dictationId, format, startOptions)) {
      return;
    }
    const resumeOptions = resumeOptionsOf(startOptions);
    const inFlight = this.starting.get(dictationId);
    if (inFlight && inFlight.format === format && sameResumeOptions(inFlight.resumeOptions, resumeOptions)) {
      return;
    }

    this.cleanupStream(dictationId);

    const inputRate = parsePcmRateFromFormat(format, 16000) ?? 16000;
    if (!Number.isFinite(inputRate) || inputRate <= 0) {
      this.failStream(dictationId, `Invalid dictation input rate in format: ${format}`, false);
      return;
    }

    const attempt = { format, resumeOptions };
    this.starting.set(dictationId, attempt);
    let resolved;
    try {
      resolved = await this.createSttSession(startOptions);
    } catch (error) {
      if (this.starting.get(dictationId) === attempt) {
        this.starting.delete(dictationId);
        this.failStream(dictationId, (hasMessage(error) && error.message) || String(error), true);
      }
      return;
    }
    if (this.starting.get(dictationId) !== attempt) {
      try {
        resolved?.session?.close();
      } catch {
        void 0;
      }
      return;
    }
    this.starting.delete(dictationId);
    if (!resolved || resolved.error) {
      this.failStream(
        dictationId,
        resolved?.error || 'Dictation STT not configured',
        Boolean(resolved?.retryable),
        resolved?.reasonCode,
      );
      return;
    }

    const stt = resolved.session;
    if (stt === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'on')");
    }
    const openaiCompatible = startOptions.provider === 'openai-compatible';
    const segmentMinSeconds = this.segmentMinSeconds ?? (openaiCompatible ? OPENAI_SEGMENT_MIN_SECONDS : DEFAULT_SEGMENT_MIN_SECONDS);
    const segmentMaxSeconds = this.segmentMaxSeconds ?? (openaiCompatible ? OPENAI_SEGMENT_MAX_SECONDS : DEFAULT_SEGMENT_MAX_SECONDS);

    stt.on('committed', ({ segmentId }) => {
      const state = this.streams.get(dictationId);
      if (!state || state.stt !== stt) {
        return;
      }
      state.committedSegmentIds.push(segmentId);
      state.pendingCommits = Math.max(0, state.pendingCommits - 1);
      const committedBytes = state.pendingCommitBytes.shift() ?? 0;
      if (!state.finalTranscriptSegmentIds.has(segmentId)) {
        state.pendingAudioBySegmentId.set(segmentId, committedBytes);
      }

      this.maybeFinalizeStream(dictationId);
    });

    stt.on('transcript', ({ segmentId, transcript, isFinal }) => {
      const state = this.streams.get(dictationId);
      if (!state || state.stt !== stt) {
        return;
      }
      state.transcriptsBySegmentId.set(segmentId, transcript);
      if (isFinal) {
        state.finalTranscriptSegmentIds.add(segmentId);
        state.pendingAudioBySegmentId.delete(segmentId);
      }

      const orderedIds = state.committedSegmentIds.includes(segmentId)
        ? state.committedSegmentIds
        : [...state.committedSegmentIds, segmentId];
      const partialText = orderedIds
        .map((id) => state.transcriptsBySegmentId.get(id) ?? '')
        .join(' ')
        .trim();
      this.emit({ type: 'partial', payload: { dictationId, text: partialText } });

      this.maybeSealStreamFinish(dictationId);
      this.maybeFinalizeStream(dictationId);
    });

    stt.on('error', (err) => {
      if (this.streams.get(dictationId)?.stt !== stt) {
        return;
      }
      const message = (hasMessage(err) && err.message) || String(err);
      this.failAndCleanupStream(dictationId, message, true);
    });

    this.streams.set(dictationId, {
      dictationId,
      inputFormat: format,
      resumeOptions,
      stt,
      inputRate,
      outputRate: stt.requiredSampleRate,
      resampler:
        inputRate === stt.requiredSampleRate
          ? null
          : new Pcm16MonoResampler({ inputRate, outputRate: stt.requiredSampleRate }),
      receivedChunks: new Map(),
      nextSeqToForward: 0,
      ackSeq: -1,
      segmentMinBytes: secondsToPcm16Bytes(segmentMinSeconds, stt.requiredSampleRate),
      segmentMaxBytes: secondsToPcm16Bytes(segmentMaxSeconds, stt.requiredSampleRate),
      pauseFrameSamples: Math.max(1, Math.round((stt.requiredSampleRate * PAUSE_FRAME_MS) / 1000)),
      recentChunkFloors: [],
      loudestRms: 0,
      quietRunFrames: 0,
      bytesSinceCommit: 0,
      peakSinceCommit: 0,
      committedSegmentIds: [],
      transcriptsBySegmentId: new Map(),
      finalTranscriptSegmentIds: new Set(),
      pendingCommits: 0,
      pendingCommitBytes: [],
      pendingAudioBySegmentId: new Map(),
      finishRequested: false,
      finishSealed: false,
      finalSeq: null,
      finalTimeout: null,
      idleTimer: setTimeout(() => this.releaseIdleStream(dictationId), this.idleReleaseMs),
      correction:
        startOptions.correct === true && this.correctTranscript
          ? { language: startOptions.language }
          : null,
      correcting: false,
    });

    this.emitAck(dictationId, -1);
  }

  handleChunk({ dictationId, seq, audioBase64 }: { dictationId: string; seq: number; audioBase64: string }) {
    const state = this.streams.get(dictationId);
    if (!state) {
      this.failStream(dictationId, 'Dictation stream not started', true, STREAM_RELEASED);
      return;
    }
    state.idleTimer.refresh();

    if (!Number.isInteger(seq) || seq < 0) {
      return;
    }

    if (seq < state.nextSeqToForward) {
      this.emitAck(dictationId, state.ackSeq);
      return;
    }

    if (!state.receivedChunks.has(seq)) {
      let chunk;
      try {
        chunk = Buffer.from(audioBase64, 'base64');
      } catch {
        return;
      }
      if (chunk.length % 2 !== 0) {
        chunk = chunk.subarray(0, chunk.length - 1);
      }
      state.receivedChunks.set(seq, chunk);
    }

    while (state.receivedChunks.has(state.nextSeqToForward)) {
      const nextSeq = state.nextSeqToForward;
      const pcm16 = state.receivedChunks.get(nextSeq);
      if (pcm16 === undefined) {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      }
      state.receivedChunks.delete(nextSeq);

      const resampled = state.resampler ? state.resampler.processChunk(pcm16) : pcm16;
      if (resampled.length > 0) {
        try {
          this.forwardAudio(state, resampled);
        } catch (error) {
          this.failAndCleanupStream(dictationId, (hasMessage(error) && error.message) || String(error), true);
          return;
        }
      }

      state.nextSeqToForward += 1;
      state.ackSeq = state.nextSeqToForward - 1;
    }

    this.emitAck(dictationId, state.ackSeq);
    this.maybeSealStreamFinish(dictationId);
    this.maybeFinalizeStream(dictationId);
  }

  handleFinish(dictationId: string, finalSeq: number) {
    const state = this.streams.get(dictationId);
    if (!state) {
      this.failStream(dictationId, 'Dictation stream not started', true, STREAM_RELEASED);
      return;
    }

    state.finishRequested = true;
    state.finalSeq = state.finalSeq === null ? finalSeq : Math.max(state.finalSeq, finalSeq);

    if (
      state.finalSeq >= 0 &&
      state.ackSeq < 0 &&
      state.nextSeqToForward === 0 &&
      state.receivedChunks.size === 0
    ) {
      this.failStream(
        dictationId,
        'Dictation finished but no audio chunks were received',
        true,
      );
      this.cleanupStream(dictationId);
      return;
    }

    this.maybeSealStreamFinish(dictationId);
    this.maybeFinalizeStream(dictationId);

    const updatedState = this.streams.get(dictationId);
    if (!updatedState) {
      return;
    }

    const timeoutMs = this.estimateFinalizationTimeout(updatedState);
    if (updatedState.finalTimeout) {
      clearTimeout(updatedState.finalTimeout);
    }
    updatedState.finalTimeout = setTimeout(() => {
      this.failAndCleanupStream(dictationId, 'Timed out waiting for final transcription', true);
    }, timeoutMs);

    this.emit({ type: 'finish_accepted', payload: { dictationId, timeoutMs } });
  }

  handleCancel(dictationId: string) {
    this.cleanupStream(dictationId);
  }

  emitAck(dictationId: string, ackSeq: number) {
    this.emit({ type: 'ack', payload: { dictationId, ackSeq } });
  }

  failStream(dictationId: string, error: DictationSessionResult['error'], retryable: boolean, reasonCode?: string) {
    const payload: Extract<DictationStreamMessage, { type: 'error' }>['payload'] = {
      dictationId,
      error,
      retryable,
    };
    if (reasonCode) payload.reasonCode = reasonCode;
    this.emit({
      type: 'error',
      payload,
    });
  }

  failAndCleanupStream(dictationId: string, error: DictationSessionResult['error'], retryable: boolean) {
    this.failStream(dictationId, error, retryable);
    this.cleanupStream(dictationId);
  }

  releaseIdleStream(dictationId: string) {
    if (this.streams.get(dictationId)?.finishRequested) {
      return;
    }
    this.failStream(dictationId, 'Dictation stream received no audio and was released', true, STREAM_RELEASED);
    this.cleanupStream(dictationId);
  }

  cleanupStream(dictationId: string) {
    this.starting.delete(dictationId);
    const state = this.streams.get(dictationId);
    if (!state) {
      return;
    }
    clearTimeout(state.idleTimer);
    if (state.finalTimeout) {
      clearTimeout(state.finalTimeout);
    }
    try {
      state.stt.close();
    } catch {
      void 0;
    }
    this.streams.delete(dictationId);
  }

  estimateFinalizationTimeout(state: DictationStreamState) {
    const bytesPerSecond = Math.max(1, state.outputRate * 2);
    const pendingCommittedSegments = state.committedSegmentIds.reduce<number>((count, segmentId) => {
      return state.finalTranscriptSegmentIds.has(segmentId) ? count : count + 1;
    }, 0);
    const committedSet = new Set(state.committedSegmentIds);
    const pendingUncommittedTranscriptSegments = Array.from(
      state.transcriptsBySegmentId.keys(),
    ).reduce<number>((count, segmentId) => {
      if (committedSet.has(segmentId)) {
        return count;
      }
      return state.finalTranscriptSegmentIds.has(segmentId) ? count : count + 1;
    }, 0);
    const pendingSegments =
      pendingCommittedSegments + pendingUncommittedTranscriptSegments + state.pendingCommits;
    const pendingBytes = state.bytesSinceCommit
      + state.pendingCommitBytes.reduce((sum, bytes) => sum + bytes, 0)
      + Array.from(state.pendingAudioBySegmentId.values()).reduce((sum, bytes) => sum + bytes, 0);
    const pendingAudioSeconds = Math.ceil(Math.max(0, pendingBytes) / bytesPerSecond);
    const missingSeqCount =
      state.finalSeq === null ? 0 : Math.max(0, state.finalSeq - state.ackSeq);

    const extraMs =
      pendingSegments * FINAL_TIMEOUT_PER_PENDING_SEGMENT_MS +
      pendingAudioSeconds * FINAL_TIMEOUT_PER_PENDING_AUDIO_SECOND_MS +
      missingSeqCount * FINAL_TIMEOUT_PER_MISSING_SEQ_MS;

    const transcriptionMs = Math.max(
      this.finalTimeoutMs,
      Math.min(FINAL_TIMEOUT_MAX_MS, this.finalTimeoutMs + extraMs),
    );
    return transcriptionMs + (state.correction ? CORRECTION_TIMEOUT_MS : 0);
  }

  forwardAudio(state: DictationStreamState, pcm16: Buffer) {
    const cutAt = findSegmentCut(state, pcm16);
    if (cutAt === null) {
      this.appendToSegment(state, pcm16);
      return;
    }
    this.appendToSegment(state, pcm16.subarray(0, cutAt));
    this.endSegment(state);
    this.appendToSegment(state, pcm16.subarray(cutAt));
  }

  appendToSegment(state: DictationStreamState, pcm16: Buffer) {
    if (pcm16.length === 0) {
      return;
    }
    state.stt.appendPcm16(pcm16);
    state.bytesSinceCommit += pcm16.length;
    state.peakSinceCommit = Math.max(state.peakSinceCommit, pcm16lePeakAbs(pcm16));
  }

  endSegment(state: DictationStreamState) {
    const silent = state.peakSinceCommit < SILENCE_PEAK_THRESHOLD;
    const segmentBytes = state.bytesSinceCommit;
    state.bytesSinceCommit = 0;
    state.peakSinceCommit = 0;
    if (silent) {
      state.stt.clear();
      return;
    }
    this.commitSegment(state, segmentBytes);
  }

  commitSegment(state: DictationStreamState, segmentBytes: number) {
    state.pendingCommits += 1;
    state.pendingCommitBytes.push(segmentBytes);
    try {
      state.stt.commit();
    } catch (error) {
      state.pendingCommits -= 1;
      state.pendingCommitBytes.pop();
      throw error;
    }
  }

  maybeSealStreamFinish(dictationId: string) {
    const state = this.streams.get(dictationId);
    if (!state) {
      return;
    }
    if (!state.finishRequested || state.finalSeq === null) {
      return;
    }
    if (state.ackSeq < state.finalSeq) {
      return;
    }
    if (state.finishSealed) {
      return;
    }

    if (state.bytesSinceCommit > 0) {
      const silent = state.peakSinceCommit < SILENCE_PEAK_THRESHOLD;
      try {
        this.endSegment(state);
      } catch (error) {
        this.failAndCleanupStream(dictationId, (hasMessage(error) && error.message) || String(error), true);
        return;
      }
      if (silent) {
        this.dropUncommittedNonFinalTranscripts(state);
      }
    }

    state.finishSealed = true;
  }

  dropUncommittedNonFinalTranscripts(state: DictationStreamState) {
    const committedSet = new Set(state.committedSegmentIds);
    for (const segmentId of Array.from(state.transcriptsBySegmentId.keys())) {
      if (committedSet.has(segmentId)) {
        continue;
      }
      if (state.finalTranscriptSegmentIds.has(segmentId)) {
        continue;
      }
      state.transcriptsBySegmentId.delete(segmentId);
    }
  }

  maybeFinalizeStream(dictationId: string) {
    const state = this.streams.get(dictationId);
    if (!state || state.correcting) {
      return;
    }

    if (!state.finishRequested || state.finalSeq === null) {
      return;
    }
    if (state.ackSeq < state.finalSeq) {
      return;
    }
    if (state.pendingCommits > 0) {
      return;
    }

    const committedSet = new Set(state.committedSegmentIds);
    const orderedSegmentIds = [...state.committedSegmentIds];
    for (const segmentId of state.transcriptsBySegmentId.keys()) {
      if (!committedSet.has(segmentId)) {
        orderedSegmentIds.push(segmentId);
      }
    }

    if (orderedSegmentIds.length === 0) {
      this.emit({ type: 'final', payload: { dictationId, text: '' } });
      this.cleanupStream(dictationId);
      return;
    }

    const allTranscriptsReady = orderedSegmentIds.every((segmentId) =>
      state.finalTranscriptSegmentIds.has(segmentId),
    );
    if (!allTranscriptsReady) {
      return;
    }

    const orderedText = orderedSegmentIds
      .map((segmentId) => state.transcriptsBySegmentId.get(segmentId) ?? '')
      .join(' ')
      .trim();

    if (!state.correction || !orderedText) {
      this.emit({ type: 'final', payload: { dictationId, text: orderedText } });
      this.cleanupStream(dictationId);
      return;
    }

    state.correcting = true;
    if (this.correctTranscript === null) {
      throw new TypeError('this.correctTranscript is not a function');
    }
    void this.correctTranscript(orderedText, state.correction)
      .catch(() => orderedText)
      .then((text) => {
        if (this.streams.get(dictationId) !== state) {
          return;
        }
        this.emit({ type: 'final', payload: { dictationId, text } });
        this.cleanupStream(dictationId);
      });
  }
}
