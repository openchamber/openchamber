/**
 * Sherpa-onnx offline recognizer engine (NeMo transducer / Parakeet) plus a
 * realtime streaming transcription session that re-decodes the accumulated
 * segment audio on a throttle to produce live partial transcripts.
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
   * @param {{ encoder: string, decoder: string, joiner: string, tokens: string, numThreads?: number }} config
   */
  constructor(config) {
    assertFileExists(config.encoder, 'offline encoder');
    assertFileExists(config.decoder, 'offline decoder');
    assertFileExists(config.joiner, 'offline joiner');
    assertFileExists(config.tokens, 'tokens');

    const sherpa = loadSherpaOnnxNode();

    const recognizerConfig = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
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
      },
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
 * Streaming transcription session backed by the offline recognizer.
 * Accumulates the current segment's PCM and re-decodes it at most every
 * `minDecodeIntervalMs` to emit non-final partial transcripts; `commit()`
 * finalizes the segment and starts a new one.
 *
 * Implements the StreamingTranscriptionSession contract used by
 * DictationStreamManager.
 */
export class SherpaRealtimeTranscriptionSession extends EventEmitter {
  /**
   * @param {{ engine: SherpaOfflineRecognizerEngine, minDecodeIntervalMs?: number }} params
   */
  constructor({ engine, minDecodeIntervalMs }) {
    super();
    this.engine = engine;
    this.requiredSampleRate = engine.sampleRate;
    this.minDecodeIntervalMs = minDecodeIntervalMs ?? 350;
    this.connected = false;
    this.currentSegmentId = null;
    this.previousSegmentId = null;
    this.lastPartialText = '';
    this.pcm16 = Buffer.alloc(0);
    this.lastDecodeAt = 0;
    this.decoding = false;
    this.pendingDecode = false;
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
      this.emit('error', new Error('Sherpa realtime session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
    this.maybeDecode(false).catch((err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  commit() {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa realtime session not connected'));
      return;
    }

    void (async () => {
      try {
        await this.maybeDecode(true);
        const finalText = this.lastPartialText;
        const segmentId = this.currentSegmentId;
        const previousSegmentId = this.previousSegmentId;

        this.emit('committed', { segmentId, previousSegmentId });
        this.emit('transcript', { segmentId, transcript: finalText, isFinal: true });

        this.previousSegmentId = segmentId;
        this.currentSegmentId = randomUUID();
        this.lastPartialText = '';
        this.pcm16 = Buffer.alloc(0);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  clear() {
    if (!this.connected) {
      return;
    }
    this.pcm16 = Buffer.alloc(0);
    this.currentSegmentId = randomUUID();
    this.lastPartialText = '';
  }

  close() {
    this.connected = false;
    this.currentSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
  }

  async maybeDecode(force) {
    if (!this.connected || !this.currentSegmentId) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastDecodeAt < this.minDecodeIntervalMs) {
      return;
    }

    if (this.decoding) {
      this.pendingDecode = true;
      return;
    }

    this.decoding = true;
    try {
      const text = this.engine.decodePcm16(this.pcm16);
      this.lastDecodeAt = Date.now();
      if (text !== this.lastPartialText) {
        this.lastPartialText = text;
        this.emit('transcript', {
          segmentId: this.currentSegmentId,
          transcript: text,
          isFinal: false,
        });
      }
    } finally {
      this.decoding = false;
      if (this.pendingDecode) {
        this.pendingDecode = false;
        await this.maybeDecode(true);
      }
    }
  }
}
