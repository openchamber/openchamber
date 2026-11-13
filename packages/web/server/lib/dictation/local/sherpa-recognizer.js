/**
 * Sherpa-onnx offline recognizer engine (Parakeet, Whisper, Qwen3-ASR) plus a
 * segment transcription session that decodes each segment exactly once, when
 * the segment is committed.
 *
 * Parakeet is an offline model: it is trained to see a whole utterance at
 * once. Decoding the accumulated audio repeatedly to animate a live transcript
 * costs O(n^2) work for a result the final decode throws away, so this session
 * only decodes on commit.
 *
 * Runs inside the dictation worker process only — never load the native
 * addon in the main server process.
 */

import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

import { loadSherpaOnnxNode } from './sherpa-loader.js';
import { resolveModelLanguage } from './model-language.js';
import { pcm16lePeakAbs, pcm16leToFloat32 } from '../audio.js';

function assertFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

/**
 * The model-specific part of sherpa's OfflineModelConfig for a catalog entry.
 * @param {string} type catalog `type`
 * @param {(role: string) => string} file absolute path of a catalog file role
 * @param {string} language the model's language hint, '' to auto-detect
 */
function buildModelSpecificConfig(type, file, language) {
  switch (type) {
    case 'nemo_transducer':
      return {
        transducer: { encoder: file('encoder'), decoder: file('decoder'), joiner: file('joiner') },
        tokens: file('tokens'),
        modelType: 'nemo_transducer',
      };
    case 'whisper':
      return {
        whisper: {
          encoder: file('encoder'),
          decoder: file('decoder'),
          // Whisper takes the language per recognizer, not per stream. Empty
          // auto-detects.
          language,
          task: 'transcribe',
          tailPaddings: -1,
        },
        tokens: file('tokens'),
        modelType: 'whisper',
      };
    case 'qwen3_asr':
      return {
        qwen3Asr: {
          convFrontend: file('convFrontend'),
          encoder: file('encoder'),
          decoder: file('decoder'),
          tokenizer: file('tokenizer'),
          // The default of 128 new tokens cuts off a 25 s segment of fast
          // speech mid-sentence.
          maxNewTokens: 512,
          hotwords: '',
        },
        tokens: '',
      };
    default:
      throw new Error(`Unsupported local speech model type: ${type}`);
  }
}

export class SherpaOfflineRecognizerEngine {
  /**
   * @param {{ modelId?: string, type: 'nemo_transducer' | 'whisper' | 'qwen3_asr',
   *           modelDir: string, files: Record<string, string>,
   *           language?: string, numThreads?: number }} config
   *   `language` is the user's dictation language; models that take no hint
   *   or do not know it detect the language themselves.
   */
  constructor(config) {
    this.language = resolveModelLanguage(config.modelId, config.type, config.language);
    this.type = config.type;
    const file = (role) => {
      const filePath = path.join(config.modelDir, config.files[role]);
      assertFileExists(filePath, role);
      return filePath;
    };
    const modelConfig = {
      ...buildModelSpecificConfig(config.type, file, this.language),
      numThreads: config.numThreads ?? 2,
      provider: 'cpu',
      debug: 0,
    };

    const sherpa = loadSherpaOnnxNode();

    const recognizerConfig = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    };

    this.recognizer = new sherpa.OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === 'number' && Number.isFinite(sr) && sr > 0
        ? sr
        : recognizerConfig.featConfig.sampleRate;
  }

  createStream() {
    return this.recognizer.createStream();
  }

  acceptWaveform(stream, sampleRate, samples) {
    if (!stream || typeof stream.acceptWaveform !== 'function') {
      throw new Error('Unexpected sherpa offline stream: missing acceptWaveform()');
    }
    // sherpa-onnx-node expects acceptWaveform({ samples, sampleRate });
    // the WASM build expects acceptWaveform(sampleRate, samples).
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
  }

  /**
   * Decode a full PCM16 segment and return its text.
   * Applies auto-gain when the peak is low so quiet microphones still decode.
   * @param {Buffer} pcm16
   * @returns {string}
   */
  decodePcm16(pcm16) {
    if (pcm16.length === 0) {
      return '';
    }

    const peak = pcm16lePeakAbs(pcm16);
    const peakFloat = peak / 32768.0;
    const targetPeak = 0.6;
    const maxGain = 50;
    const gain =
      peakFloat > 0 && peakFloat < targetPeak ? Math.min(maxGain, targetPeak / peakFloat) : 1;

    const stream = this.createStream();
    try {
      // Qwen3-ASR reads its language hint per stream.
      if (this.type === 'qwen3_asr' && this.language) {
        stream.setOption('language', this.language);
      }
      const floatSamples = pcm16leToFloat32(pcm16, gain);
      this.acceptWaveform(stream, this.sampleRate, floatSamples);
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      const text =
        typeof result === 'object' && result && 'text' in result ? result.text : result;
      return String(text ?? '').trim();
    } finally {
      try {
        stream.free?.();
      } catch {
        // ignore
      }
    }
  }

  free() {
    try {
      this.recognizer?.free?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Segment transcription session backed by the offline recognizer.
 * Accumulates the current segment's PCM and decodes it once in `commit()`,
 * which emits the segment's final transcript and starts a new segment.
 *
 * Implements the StreamingTranscriptionSession contract used by
 * DictationStreamManager. It never emits non-final transcripts: the manager's
 * live `partial` messages are the concatenation of already-committed segments.
 */
export class SherpaSegmentTranscriptionSession extends EventEmitter {
  /**
   * @param {{ engine: SherpaOfflineRecognizerEngine }} params
   */
  constructor({ engine }) {
    super();
    this.engine = engine;
    this.requiredSampleRate = engine.sampleRate;
    this.connected = false;
    this.currentSegmentId = null;
    this.previousSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
  }

  async connect() {
    if (this.connected) {
      return;
    }
    this.currentSegmentId = randomUUID();
    this.connected = true;
  }

  appendPcm16(chunk) {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa transcription session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
  }

  /**
   * Close the current segment and hand it back for decoding, WITHOUT decoding.
   * The caller decodes later (e.g. on the next event-loop turn) so a long
   * segment's quadratic decode never blocks the worker's IPC — see
   * worker-process.js session.commit. Returns null when not connected or the
   * segment holds no audio.
   * @returns {{ segmentId: string, previousSegmentId: string|null, pcm16: Buffer } | null}
   */
  takePendingSegment() {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa transcription session not connected'));
      return null;
    }
    const segmentId = this.currentSegmentId;
    const previousSegmentId = this.previousSegmentId;
    const pcm16 = this.pcm16;

    // Start the next segment before decoding: decoding can take seconds on
    // long segments, and audio for the next one keeps arriving meanwhile.
    this.previousSegmentId = segmentId;
    this.currentSegmentId = randomUUID();
    this.pcm16 = Buffer.alloc(0);

    this.emit('committed', { segmentId, previousSegmentId });

    if (pcm16.length === 0) {
      return null;
    }
    return { segmentId, previousSegmentId, pcm16 };
  }

  /**
   * Decode a segment previously returned by takePendingSegment() and emit its
   * final transcript.
   * @param {{ segmentId: string, pcm16: Buffer }} pending
   */
  decodeSegment(pending) {
    let transcript;
    try {
      transcript = this.engine.decodePcm16(pending.pcm16);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.emit('transcript', { segmentId: pending.segmentId, transcript, isFinal: true });
  }

  commit() {
    const pending = this.takePendingSegment();
    if (pending) {
      this.decodeSegment(pending);
    }
  }

  clear() {
    if (!this.connected) {
      return;
    }
    this.pcm16 = Buffer.alloc(0);
    this.currentSegmentId = randomUUID();
  }

  close() {
    this.connected = false;
    this.currentSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
  }
}
