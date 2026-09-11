/**
 * Sherpa-onnx offline recognizer engine (NeMo transducer / Parakeet) plus a
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

import { loadSherpaOnnxNode } from './sherpa-loader.js';
import { pcm16lePeakAbs, pcm16leToFloat32 } from '../audio.js';

function assertFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export class SherpaOfflineRecognizerEngine {
  /**
   * @param {{ type: 'nemo_transducer' | 'whisper',
   *           encoder: string, decoder: string, joiner?: string, tokens: string,
   *           numThreads?: number }} config
   */
  constructor(config) {
    assertFileExists(config.encoder, 'offline encoder');
    assertFileExists(config.decoder, 'offline decoder');
    if (config.type === 'nemo_transducer') {
      assertFileExists(config.joiner, 'offline joiner');
    }
    assertFileExists(config.tokens, 'tokens');

    const sherpa = loadSherpaOnnxNode();

    const modelConfig =
      config.type === 'whisper'
        ? {
            whisper: {
              encoder: config.encoder,
              decoder: config.decoder,
              // Empty language auto-detects for multilingual Whisper exports.
              language: '',
              task: 'transcribe',
              tailPaddings: -1,
            },
            tokens: config.tokens,
            modelType: 'whisper',
            numThreads: config.numThreads ?? 2,
            provider: 'cpu',
            debug: 0,
          }
        : {
            transducer: {
              encoder: config.encoder,
              decoder: config.decoder,
              joiner: config.joiner,
            },
            tokens: config.tokens,
            modelType: 'nemo_transducer',
            numThreads: config.numThreads ?? 2,
            provider: 'cpu',
            debug: 0,
          };

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

  commit() {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa transcription session not connected'));
      return;
    }

    const segmentId = this.currentSegmentId;
    const previousSegmentId = this.previousSegmentId;
    const pcm16 = this.pcm16;

    // Start the next segment before decoding: decoding blocks the worker for
    // seconds on long segments, and audio for the next one keeps arriving.
    this.previousSegmentId = segmentId;
    this.currentSegmentId = randomUUID();
    this.pcm16 = Buffer.alloc(0);

    this.emit('committed', { segmentId, previousSegmentId });

    let transcript;
    try {
      transcript = this.engine.decodePcm16(pcm16);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.emit('transcript', { segmentId, transcript, isFinal: true });
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
