
import { existsSync } from 'fs';
import path from 'path';

import { loadSherpaOnnxNode } from './sherpa-loader.js';
import type { SherpaNodeModule } from './sherpa-loader.js';

interface TtsFilePair {
  model: string;
  tokens: string;
}

export type SherpaTtsConfig<LexiconRole extends string> = {
  modelDir: string;
  numThreads?: number;
} & (
  | { type: 'vits'; files: TtsFilePair & { espeakData?: string } }
  | {
    type?: 'kokoro';
    files: TtsFilePair & { espeakData: string; voices: string } & Record<LexiconRole, string>;
    lexicon?: LexiconRole[] | undefined;
  }
);

export interface SherpaTtsOptions {
  speakerId?: unknown;
  speed?: unknown;
}

interface OfflineTts {
  generate(request: { text: string; sid: number; speed: number; enableExternalBuffer: boolean }):
    { samples?: unknown; sampleRate?: unknown } | null | undefined;
  sampleRate?: unknown;
  free?(): void;
}

type OfflineTtsConstructor = new (config: {
  model: ReturnType<typeof buildModelConfig>;
  numThreads: number;
  provider: string;
  maxNumSentences: number;
}) => OfflineTts;

function hasOfflineTts(sherpa: SherpaNodeModule): sherpa is SherpaNodeModule & { OfflineTts: OfflineTtsConstructor } {
  return typeof sherpa.OfflineTts === 'function';
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && value > 0;
}

function isSpeakerId(value: unknown): value is number {
  return Number.isInteger(value);
}

function assertFileExists(filePath: string, label: string) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function float32ToPcm16le(samples: Float32Array) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? NaN));
    out[i] = Math.round(clamped * 32767);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function buildModelConfig<LexiconRole extends string>(config: SherpaTtsConfig<LexiconRole>) {
  const file = (name: string, label: string) => {
    const filePath = path.join(config.modelDir, name);
    assertFileExists(filePath, label);
    return filePath;
  };
  const modelPath = file(config.files.model, 'TTS model');
  const tokensPath = file(config.files.tokens, 'TTS tokens');

  if (config.type === 'vits') {
    const dataDir = config.files.espeakData ? file(config.files.espeakData, 'TTS espeak-ng dataDir') : '';
    if (dataDir) {
      return { vits: { model: modelPath, tokens: tokensPath, dataDir, lengthScale: 1.0 } };
    }
    return { vits: { model: modelPath, tokens: tokensPath, lengthScale: 1.0 } };
  }

  const dataDir = file(config.files.espeakData, 'TTS espeak-ng dataDir');
  const voicesPath = file(config.files.voices, 'TTS voices');
  const lexicon = (config.lexicon ?? []).map((key) => file(config.files[key], 'TTS lexicon')).join(',');
  const kokoro: TtsFilePair & { voices: string; dataDir: string; lengthScale: number; lexicon?: string } = {
    model: modelPath,
    voices: voicesPath,
    tokens: tokensPath,
    dataDir,
    lengthScale: 1.0,
  };
  if (lexicon) {
    kokoro.lexicon = lexicon;
  }
  return { kokoro };
}

export class SherpaTtsEngine<LexiconRole extends string> {
  tts: OfflineTts;

  constructor(config: SherpaTtsConfig<LexiconRole>) {
    const model = buildModelConfig(config);

    const sherpa = loadSherpaOnnxNode();
    if (!hasOfflineTts(sherpa)) {
      throw new Error('sherpa-onnx-node OfflineTts is unavailable');
    }

    this.tts = new sherpa.OfflineTts({
      model,
      numThreads: config.numThreads ?? 2,
      provider: 'cpu',
      maxNumSentences: 1,
    });
  }

  synthesize(text: string, options: SherpaTtsOptions = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      throw new Error('Cannot synthesize empty text');
    }

    const audio = this.tts.generate({
      text: trimmed,
      sid: isSpeakerId(options.speakerId) ? options.speakerId : 0,
      speed: isPositiveNumber(options.speed) ? options.speed : 1.0,
      enableExternalBuffer: false,
    });

    let samples = null;
    if (audio && audio.samples instanceof Float32Array) {
      samples = Float32Array.from(audio.samples);
    } else if (audio && Array.isArray(audio.samples)) {
      samples = Float32Array.from(audio.samples);
    }
    if (!samples) {
      throw new Error('Unexpected sherpa TTS output: missing Float32 samples');
    }

    const sampleRate =
      audio && isPositiveNumber(audio.sampleRate)
        ? audio.sampleRate
        : isPositiveNumber(this.tts.sampleRate)
          ? this.tts.sampleRate
          : 24000;

    return { pcm16: float32ToPcm16le(samples), sampleRate };
  }

  free() {
    try {
      this.tts?.free?.();
    } catch {
      return;
    }
  }
}
