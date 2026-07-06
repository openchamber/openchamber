/**
 * DictationStreamManager
 *
 * Server-authoritative streaming dictation state machine. One manager owns
 * all dictation streams for a single WebSocket connection.
 *
 * Responsibilities:
 * - Reorders inbound chunks by `seq` and acks the highest contiguous seq.
 * - Resamples client PCM (16 kHz by default) to the provider's required rate.
 * - Auto-commits a segment every `autoCommitSeconds` of audio, but clears
 *   silence-only segments instead of committing them.
 * - Concatenates per-segment transcripts into live partials and emits the
 *   final text once every committed segment has a final transcript.
 * - Applies an adaptive finalization timeout budget based on pending work.
 */

import { Pcm16MonoResampler, parsePcmRateFromFormat, pcm16lePeakAbs } from './audio.js';

const DEFAULT_FINAL_TIMEOUT_MS = 10000;
const DEFAULT_AUTO_COMMIT_SECONDS = 15;
const FINAL_TIMEOUT_MAX_MS = 5 * 60 * 1000;
const FINAL_TIMEOUT_PER_PENDING_SEGMENT_MS = 15 * 1000;
const FINAL_TIMEOUT_PER_PENDING_AUDIO_SECOND_MS = 1500;
const FINAL_TIMEOUT_PER_MISSING_SEQ_MS = 250;
const SILENCE_PEAK_THRESHOLD = 300;

export class DictationStreamManager {
  /**
   * @param {object} params
   * @param {(msg: { type: string, payload: object }) => void} params.emit
   * @param {(startOptions: object) => Promise<{ session: object } | { error: string, retryable: boolean, reasonCode?: string }>} params.createSttSession
   *   Resolves a connected streaming transcription session for one dictation.
   *   The streaming transcription session contract:
   *   { requiredSampleRate, appendPcm16(buf), commit(), clear(), close(), on(event, handler) }
   * @param {number} [params.finalTimeoutMs]
   * @param {number} [params.autoCommitSeconds]
   */
  constructor({ emit, createSttSession, finalTimeoutMs, autoCommitSeconds }) {
    this.emit = emit;
    this.createSttSession = createSttSession;
    this.finalTimeoutMs = finalTimeoutMs ?? DEFAULT_FINAL_TIMEOUT_MS;
    this.autoCommitSeconds = autoCommitSeconds ?? DEFAULT_AUTO_COMMIT_SECONDS;
    this.streams = new Map();
  }

  cleanupAll() {
    for (const dictationId of Array.from(this.streams.keys())) {
      this.cleanupStream(dictationId);
    }
  }

  /**
   * @param {string} dictationId
   * @param {string} format e.g. "audio/pcm;rate=16000;bits=16"
   * @param {object} startOptions provider/config options forwarded to createSttSession
   */
  async handleStart(dictationId, format, startOptions = {}) {
    this.cleanupStream(dictationId);

    const inputRate = parsePcmRateFromFormat(format, 16000) ?? 16000;
    if (!Number.isFinite(inputRate) || inputRate <= 0) {
      this.failStream(dictationId, `Invalid dictation input rate in format: ${format}`, false);
      return;
    }

    let resolved;
    try {
      resolved = await this.createSttSession(startOptions);
    } catch (error) {
      this.failStream(dictationId, error?.message || String(error), true);
      return;
    }
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

    stt.on('committed', ({ segmentId }) => {
      const state = this.streams.get(dictationId);
      if (!state) {
        return;
      }
      state.committedSegmentIds.push(segmentId);
      state.bytesSinceCommit = 0;
      state.peakSinceCommit = 0;

      if (state.finishRequested && state.awaitingFinalCommit) {
        state.awaitingFinalCommit = false;
      }

      this.maybeFinalizeStream(dictationId);
    });

    stt.on('transcript', ({ segmentId, transcript, isFinal }) => {
      const state = this.streams.get(dictationId);
      if (!state) {
        return;
      }
      state.transcriptsBySegmentId.set(segmentId, transcript);
      if (isFinal) {
        state.finalTranscriptSegmentIds.add(segmentId);
      }

      if (state.finishRequested && state.awaitingFinalCommit && isFinal) {
        state.awaitingFinalCommit = false;
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
      const message = err?.message || String(err);
      this.failAndCleanupStream(dictationId, message, true);
    });

    this.streams.set(dictationId, {
      dictationId,
      inputFormat: format,
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
      autoCommitBytes:
        this.autoCommitSeconds > 0
          ? Math.max(1, Math.round(this.autoCommitSeconds * stt.requiredSampleRate * 2))
          : 0,
      bytesSinceCommit: 0,
      peakSinceCommit: 0,
      committedSegmentIds: [],
      transcriptsBySegmentId: new Map(),
      finalTranscriptSegmentIds: new Set(),
      awaitingFinalCommit: false,
      finishRequested: false,
      finishSealed: false,
      finalSeq: null,
      finalTimeout: null,
    });

    this.emitAck(dictationId, -1);
  }

  /**
   * @param {{ dictationId: string, seq: number, audioBase64: string }} params
   */
  handleChunk({ dictationId, seq, audioBase64 }) {
    const state = this.streams.get(dictationId);
    if (!state) {
      this.failStream(dictationId, 'Dictation stream not started', true);
      return;
    }

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
      state.receivedChunks.delete(nextSeq);

      const resampled = state.resampler ? state.resampler.processChunk(pcm16) : pcm16;
      if (resampled.length > 0) {
        state.stt.appendPcm16(resampled);
        state.bytesSinceCommit += resampled.length;
        state.peakSinceCommit = Math.max(state.peakSinceCommit, pcm16lePeakAbs(resampled));
        try {
          this.maybeAutoCommitSegment(state);
        } catch (error) {
          this.failAndCleanupStream(dictationId, error?.message || String(error), true);
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

  /**
   * @param {string} dictationId
   * @param {number} finalSeq highest seq the client sent (or -1 if none)
   */
  handleFinish(dictationId, finalSeq) {
    const state = this.streams.get(dictationId);
    if (!state) {
      this.failStream(dictationId, 'Dictation stream not started', true);
      return;
    }

    state.finishRequested = true;
    state.finalSeq = finalSeq;

    if (
      finalSeq >= 0 &&
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

  handleCancel(dictationId) {
    this.cleanupStream(dictationId);
  }

  emitAck(dictationId, ackSeq) {
    this.emit({ type: 'ack', payload: { dictationId, ackSeq } });
  }

  failStream(dictationId, error, retryable, reasonCode) {
    this.emit({
      type: 'error',
      payload: {
        dictationId,
        error,
        retryable,
        ...(reasonCode ? { reasonCode } : {}),
      },
    });
  }

  failAndCleanupStream(dictationId, error, retryable) {
    this.failStream(dictationId, error, retryable);
    this.cleanupStream(dictationId);
  }

  cleanupStream(dictationId) {
    const state = this.streams.get(dictationId);
    if (!state) {
      return;
    }
    if (state.finalTimeout) {
      clearTimeout(state.finalTimeout);
    }
    try {
      state.stt.close();
    } catch {
      // no-op
    }
    this.streams.delete(dictationId);
  }

  estimateFinalizationTimeout(state) {
    const bytesPerSecond = Math.max(1, state.outputRate * 2);
    const pendingCommittedSegments = state.committedSegmentIds.reduce((count, segmentId) => {
      return state.finalTranscriptSegmentIds.has(segmentId) ? count : count + 1;
    }, 0);
    const committedSet = new Set(state.committedSegmentIds);
    const pendingUncommittedTranscriptSegments = Array.from(
      state.transcriptsBySegmentId.keys(),
    ).reduce((count, segmentId) => {
      if (committedSet.has(segmentId)) {
        return count;
      }
      return state.finalTranscriptSegmentIds.has(segmentId) ? count : count + 1;
    }, 0);
    const pendingSegments =
      pendingCommittedSegments +
      pendingUncommittedTranscriptSegments +
      (state.awaitingFinalCommit ? 1 : 0);
    const pendingAudioSeconds = Math.ceil(Math.max(0, state.bytesSinceCommit) / bytesPerSecond);
    const missingSeqCount =
      state.finalSeq === null ? 0 : Math.max(0, state.finalSeq - state.ackSeq);

    const extraMs =
      pendingSegments * FINAL_TIMEOUT_PER_PENDING_SEGMENT_MS +
      pendingAudioSeconds * FINAL_TIMEOUT_PER_PENDING_AUDIO_SECOND_MS +
      missingSeqCount * FINAL_TIMEOUT_PER_MISSING_SEQ_MS;

    return Math.max(
      this.finalTimeoutMs,
      Math.min(FINAL_TIMEOUT_MAX_MS, this.finalTimeoutMs + extraMs),
    );
  }

  maybeAutoCommitSegment(state) {
    if (state.finishRequested) {
      return;
    }
    if (state.autoCommitBytes <= 0 || state.bytesSinceCommit < state.autoCommitBytes) {
      return;
    }
    if (state.peakSinceCommit < SILENCE_PEAK_THRESHOLD) {
      state.stt.clear();
      state.bytesSinceCommit = 0;
      state.peakSinceCommit = 0;
      return;
    }

    state.bytesSinceCommit = 0;
    state.peakSinceCommit = 0;
    state.stt.commit();
  }

  maybeSealStreamFinish(dictationId) {
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
      if (state.peakSinceCommit < SILENCE_PEAK_THRESHOLD) {
        state.stt.clear();
        state.bytesSinceCommit = 0;
        state.peakSinceCommit = 0;
        state.awaitingFinalCommit = false;
        this.dropUncommittedNonFinalTranscripts(state);
      } else {
        state.awaitingFinalCommit = true;
        try {
          state.stt.commit();
        } catch (error) {
          this.failAndCleanupStream(dictationId, error?.message || String(error), true);
          return;
        }
      }
    } else {
      state.awaitingFinalCommit = false;
    }

    state.finishSealed = true;
  }

  dropUncommittedNonFinalTranscripts(state) {
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

  maybeFinalizeStream(dictationId) {
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
    if (state.awaitingFinalCommit) {
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

    this.emit({ type: 'final', payload: { dictationId, text: orderedText } });
    this.cleanupStream(dictationId);
  }
}
