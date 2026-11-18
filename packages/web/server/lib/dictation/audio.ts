
export function parsePcmRateFromFormat(format: string, fallback: number | null = null) {
  const match = /(?:^|[;,\s])rate\s*=\s*(\d+)(?:$|[;,\s])/i.exec(String(format || ''));
  if (!match) {
    return fallback;
  }
  const rate = Number.parseInt(String(match[1]), 10);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

function toInt16Samples(pcm16le: Buffer) {
  if (pcm16le.byteOffset % 2 !== 0) {
    const copy = Buffer.from(pcm16le);
    return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  }
  return new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength / 2);
}

export function pcm16lePeakAbs(pcm16le: Buffer) {
  if (!pcm16le || pcm16le.length === 0) {
    return 0;
  }
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const samples = toInt16Samples(pcm16le);
  let peak = 0;
  for (const v of samples) {
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

export function pcm16leFrameRms(pcm16le: Buffer, frameSamples: number) {
  if (!pcm16le || pcm16le.length === 0 || frameSamples <= 0) {
    return [];
  }
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const samples = toInt16Samples(pcm16le);
  const frames = [];
  for (let start = 0; start + frameSamples <= samples.length; start += frameSamples) {
    let sumSquares = 0;
    for (let i = start; i < start + frameSamples; i += 1) {
      const sample = samples[i] ?? NaN;
      sumSquares += sample * sample;
    }
    frames.push(Math.sqrt(sumSquares / frameSamples));
  }
  return frames;
}

export function pcm16leToFloat32(pcm16le: Buffer, gain = 1) {
  if (pcm16le.length % 2 !== 0) {
    throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
  }
  const int16 = toInt16Samples(pcm16le);
  const out = new Float32Array(int16.length);
  for (const [i, sample] of int16.entries()) {
    const v = (sample / 32768.0) * gain;
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

export function pcm16ToWav(pcmBuffer: Buffer, sampleRate: number) {
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

export class Pcm16MonoResampler {
  inputRate: number;
  outputRate: number;
  step: number;
  pos: number;
  carrySample: number | null | undefined;

  constructor({ inputRate, outputRate }: { inputRate: number; outputRate: number }) {
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

  processChunk(pcm16le: Buffer) {
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
      src[0] = (this.carrySample ?? NaN) / 32768;
      offset = 1;
    }
    for (const [i, sample] of srcChunk.entries()) {
      src[offset + i] = sample / 32768;
    }

    const out = [];
    const maxPos = src.length - 1;

    while (this.pos < maxPos) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s0 = src[i] ?? NaN;
      const s1 = src[i + 1] ?? NaN;
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
