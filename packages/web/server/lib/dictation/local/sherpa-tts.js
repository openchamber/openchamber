
import { existsSync } from 'fs';
import path from 'path';

import { loadSherpaOnnxNode } from './sherpa-loader.js';

function assertFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function float32ToPcm16le(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * sherpa-onnx model config for one catalog entry. Kokoro carries a voices
 * bank (speaker ids) and optional lexicons; a Piper/VITS model is a single
 * voice with espeak-ng phonemization.
 * @param {{ modelDir: string, type?: string, files: Record<string, string>, lexicon?: string[] }} config
 */
function buildModelConfig(config) {
  const file = (key, label) => {
    const filePath = path.join(config.modelDir, config.files[key]);
    assertFileExists(filePath, label);
    return filePath;
  };
  const modelPath = file('model', 'TTS model');
  const tokensPath = file('tokens', 'TTS tokens');

  if (config.type === 'vits') {
    // external: https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html Piper uses espeak-ng data; character-based Coqui models read text directly.
    const dataDir = config.files.espeakData ? file('espeakData', 'TTS espeak-ng dataDir') : '';
    return { vits: { model: modelPath, tokens: tokensPath, ...(dataDir ? { dataDir } : {}), lengthScale: 1.0 } };
  }

  const dataDir = file('espeakData', 'TTS espeak-ng dataDir');
  const voicesPath = file('voices', 'TTS voices');
  const lexicon = (config.lexicon ?? []).map((key) => file(key, 'TTS lexicon')).join(',');
  return {
    kokoro: {
      model: modelPath,
      voices: voicesPath,
      tokens: tokensPath,
      dataDir,
      lengthScale: 1.0,
      ...(lexicon ? { lexicon } : {}),
    },
  };
}

export class SherpaTtsEngine {
  /**
   * @param {{ modelDir: string, type?: string, files: Record<string, string>, lexicon?: string[], numThreads?: number }} config
   */
  constructor(config) {
    const model = buildModelConfig(config);

    const sherpa = loadSherpaOnnxNode();
    if (typeof sherpa.OfflineTts !== 'function') {
      throw new Error('sherpa-onnx-node OfflineTts is unavailable');
    }

    this.tts = new sherpa.OfflineTts({
      model,
      numThreads: config.numThreads ?? 2,
      provider: 'cpu',
      maxNumSentences: 1,
    });
  }

  /**
   * Synthesize text to PCM16LE.
   * @param {string} text
   * @param {{ speakerId?: number, speed?: number }} [options]
   * @returns {{ pcm16: Buffer, sampleRate: number }}
   */
  synthesize(text, options = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      throw new Error('Cannot synthesize empty text');
    }

    const audio = this.tts.generate({
      text: trimmed,
      sid: Number.isInteger(options.speakerId) ? options.speakerId : 0,
      speed: typeof options.speed === 'number' && options.speed > 0 ? options.speed : 1.0,
      // external: https://www.electronjs.org/docs/latest/breaking-changes#behavior-changed-v8-memory-cage-enabled Electron rejects native external-backed typed arrays; request a copied buffer from sherpa.
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
      audio && typeof audio.sampleRate === 'number' && audio.sampleRate > 0
        ? audio.sampleRate
        : typeof this.tts.sampleRate === 'number' && this.tts.sampleRate > 0
          ? this.tts.sampleRate
          : 24000;

    return { pcm16: float32ToPcm16le(samples), sampleRate };
  }

  free() {
    try {
      this.tts?.free?.();
    } catch {
      // ignore
    }
  }
}
