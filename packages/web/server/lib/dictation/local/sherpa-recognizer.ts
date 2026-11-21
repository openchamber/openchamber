import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

import { loadSherpaOnnxNode } from './sherpa-loader.js';
import type { SherpaNodeModule } from './sherpa-loader.js';
import { resolveModelLanguage } from './model-language.js';
import { pcm16lePeakAbs, pcm16leToFloat32 } from '../audio.js';

interface OfflineStream {
  acceptWaveform(request: { samples: Float32Array; sampleRate: number }): void;
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  setOption(name: string, value: string): void;
  free?(): void;
}

interface OfflineRecognizer {
  config?: { featConfig?: { sampleRate?: unknown } };
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text?: unknown } | string | null | undefined;
  free?(): void;
}

interface RecognizerConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: ReturnType<typeof buildModelSpecificConfig> & { numThreads: number; provider: string; debug: number };
  decodingMethod: string;
  maxActivePaths: number;
}

type OfflineRecognizerConstructor = new (config: RecognizerConfig) => OfflineRecognizer;

export interface SherpaRecognizerConfig {
  modelId?: string;
  type: string;
  modelDir: string;
  files: Record<string, string>;
  language?: string | undefined;
  numThreads?: number;
}

export interface PendingSegment {
  segmentId: string;
  previousSegmentId: string | null;
  pcm16: Buffer;
}

function hasOfflineRecognizer(sherpa: SherpaNodeModule): sherpa is SherpaNodeModule & { OfflineRecognizer: OfflineRecognizerConstructor } {
  return typeof sherpa.OfflineRecognizer === 'function';
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function hasTextField(value: ReturnType<OfflineRecognizer['getResult']>): value is { text: unknown } {
  return typeof value === 'object' && value !== null && 'text' in value;
}

function hasWaveformInput(stream: OfflineStream | null | undefined): stream is OfflineStream {
  return Boolean(stream) && typeof stream?.acceptWaveform === 'function';
}

function freeQuietly(resource: { free?(): void } | null | undefined) {
  try {
    resource?.free?.();
  } catch {
    return;
  }
}

function assertFileExists(filePath: string, label: string) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function buildModelSpecificConfig(type: string, file: (role: string) => string, language: string) {
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
          // external: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-model-config.h Whisper language belongs to the recognizer config; an empty hint enables detection.
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
  language: string;
  type: string;
  recognizer: OfflineRecognizer;
  sampleRate: number;

  constructor(config: SherpaRecognizerConfig) {
    this.language = resolveModelLanguage(config.modelId, config.type, config.language);
    this.type = config.type;
    const file = (role: string) => {
      const name = config.files[role];
      if (name === undefined) {
        throw new Error(`Missing ${role}: the model names no such file`);
      }
      const filePath = path.join(config.modelDir, name);
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

    const recognizerConfig: RecognizerConfig = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    };

    if (!hasOfflineRecognizer(sherpa)) {
      throw new TypeError('sherpa.OfflineRecognizer is not a constructor');
    }
    this.recognizer = new sherpa.OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate = isPositiveFiniteNumber(sr) ? sr : recognizerConfig.featConfig.sampleRate;
  }

  createStream() {
    return this.recognizer.createStream();
  }

  acceptWaveform(stream: OfflineStream, sampleRate: number, samples: Float32Array) {
    if (!hasWaveformInput(stream)) {
      throw new Error('Unexpected sherpa offline stream: missing acceptWaveform()');
    }
    // external: https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/node-addon-api/lib/non-streaming-asr.js The Node binding takes acceptWaveform({ samples, sampleRate }); the WASM binding uses positional arguments.
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
  }

  decodePcm16(pcm16: Buffer) {
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
      // external: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.h Qwen3-ASR reads the language hint from each stream.
      if (this.type === 'qwen3_asr' && this.language) {
        stream.setOption('language', this.language);
      }
      const floatSamples = pcm16leToFloat32(pcm16, gain);
      this.acceptWaveform(stream, this.sampleRate, floatSamples);
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      const text = hasTextField(result) ? result.text : result;
      return String(text ?? '').trim();
    } finally {
      freeQuietly(stream);
    }
  }

  free() {
    freeQuietly(this.recognizer);
  }
}

export class SherpaSegmentTranscriptionSession extends EventEmitter {
  engine: Pick<SherpaOfflineRecognizerEngine, 'sampleRate' | 'decodePcm16'>;
  requiredSampleRate: number;
  connected: boolean;
  currentSegmentId: string | null;
  previousSegmentId: string | null;
  pcm16: Buffer;

  constructor({ engine }: { engine: Pick<SherpaOfflineRecognizerEngine, 'sampleRate' | 'decodePcm16'> }) {
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

  appendPcm16(chunk: Buffer) {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa transcription session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
  }

  takePendingSegment(): PendingSegment | null {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa transcription session not connected'));
      return null;
    }
    const segmentId = this.currentSegmentId;
    const previousSegmentId = this.previousSegmentId;
    const pcm16 = this.pcm16;

    this.previousSegmentId = segmentId;
    this.currentSegmentId = randomUUID();
    this.pcm16 = Buffer.alloc(0);

    this.emit('committed', { segmentId, previousSegmentId });

    if (pcm16.length === 0) {
      return null;
    }
    return { segmentId, previousSegmentId, pcm16 };
  }

  decodeSegment(pending: Pick<PendingSegment, 'segmentId' | 'pcm16'>) {
    let transcript: string;
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
