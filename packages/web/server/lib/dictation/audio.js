/**
 * PCM16 audio helpers for the dictation streaming pipeline.
 *
 * All dictation audio travels as 16-bit little-endian mono PCM. The client
 * captures at 16 kHz; providers may require a different rate, so chunks are
 * resampled with Pcm16MonoResampler before being appended to an STT session.
 */

/**
 * Parse the sample rate out of a format string like "audio/pcm;rate=16000;bits=16".
 * @param {string} format
 * @param {number|null} [fallback]
 * @returns {number|null}
 */
export function parsePcmRateFromFormat(format, fallback = null) {
  const match = /(?:^|[;,\s])rate\s*=\s*(\d+)(?:$|[;,\s])/i.exec(String(format || ''));
  if (!match) {
    return fallback;
  }
  const rate = Number.parseInt(match[1], 10);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

/**
 * Return an Int16Array view over a PCM16LE buffer, copying when the buffer's
 * byteOffset is not 2-byte aligned (IPC-transferred buffers can be views at
 * odd offsets, and Int16Array requires an even start offset).
 * @param {Buffer} pcm16le
 * @returns {Int16Array}
 */
function toInt16Samples(pcm16le) {
  if (pcm16le.byteOffset % 2 !== 0) {
    const copy = Buffer.from(pcm16le);
    return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  }
  return new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength / 2);
}

/**
 * Peak absolute sample value of a PCM16LE buffer. Used for silence detection.
 * @param {Buffer} pcm16le
 * @returns {number}
 */
export function pcm16lePeakAbs(pcm16le) {
  if (!pcm16le || pcm16le.length === 0) {
    return 0;
  }
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const samples = toInt16Samples(pcm16le);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    const abs = v < 0 ? -v : v;
    if (abs > peak) {
      peak = abs;
      if (peak >= 32767) {
        break;
      }
    }
  }
  return peak;
}

/**
 * Convert PCM16LE to Float32 samples in [-1, 1], with optional gain.
 * @param {Buffer} pcm16le
 * @param {number} [gain]
 * @returns {Float32Array}
 */
export function pcm16leToFloat32(pcm16le, gain = 1) {
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const int16 = toInt16Samples(pcm16le);
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) {
    const v = (int16[i] / 32768.0) * gain;
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

/**
 * Wrap raw PCM16LE mono audio in a WAV container.
 * @param {Buffer} pcmBuffer
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function pcm16ToWav(pcmBuffer, sampleRate) {
  const channels = 1;
  const bitsPerSample = 16;
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write('WAVE', 8);
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

/**
 * Streaming linear-interpolation resampler for PCM16LE mono audio.
 * Carries one sample across chunk boundaries so consecutive chunks resample
 * without seams.
 */
export class Pcm16MonoResampler {
  /**
   * @param {{ inputRate: number, outputRate: number }} params
   */
  constructor({ inputRate, outputRate }) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.step = inputRate / outputRate;
    this.pos = 0;
    this.carrySample = null;
  }

  reset() {
    this.pos = 0;
    this.carrySample = null;
  }

  /**
   * @param {Buffer} pcm16le
   * @returns {Buffer}
   */
  processChunk(pcm16le) {
    if (pcm16le.length === 0) {
      return Buffer.alloc(0);
    }
    if (pcm16le.length % 2 !== 0) {
      throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
    }

    const srcChunk = toInt16Samples(pcm16le);

    const hasCarry = this.carrySample !== null;
    const srcLen = srcChunk.length + (hasCarry ? 1 : 0);
    if (srcLen < 2) {
      this.carrySample = srcChunk.length ? srcChunk[srcChunk.length - 1] : this.carrySample;
      return Buffer.alloc(0);
    }

    const src = new Float32Array(srcLen);
    let offset = 0;
    if (hasCarry) {
      src[0] = this.carrySample / 32768;
      offset = 1;
    }
    for (let i = 0; i < srcChunk.length; i += 1) {
      src[offset + i] = srcChunk[i] / 32768;
    }

    const out = [];
    const maxPos = src.length - 1;

    while (this.pos < maxPos) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s0 = src[i];
      const s1 = src[i + 1];
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      out.push(Math.round(clamped * 32767));
      this.pos += this.step;
    }

    this.carrySample = srcChunk[srcChunk.length - 1];

    const shift = src.length - 1;
    this.pos = this.pos - shift;
    if (this.pos < 0) {
      this.pos = 0;
    }

    const outArr = Int16Array.from(out);
    return Buffer.from(outArr.buffer, outArr.byteOffset, outArr.byteLength);
  }
}
