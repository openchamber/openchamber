import { describe, expect, it } from 'vitest';

import {
  parsePcmRateFromFormat,
  pcm16lePeakAbs,
  pcm16leFrameRms,
  pcm16leToFloat32,
  pcm16ToWav,
  Pcm16MonoResampler,
} from './audio.js';

const pcm = (samples) => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
};

describe('dictation audio', () => {
  it('parses rates and preserves missing/invalid format fallbacks', () => {
    expect(parsePcmRateFromFormat('audio/pcm;rate=16000;bits=16')).toBe(16000);
    expect(parsePcmRateFromFormat('RATE = 48000, bits=16')).toBe(48000);
    expect(parsePcmRateFromFormat('audio/pcm')).toBeNull();
    expect(parsePcmRateFromFormat('rate=0', 8000)).toBe(8000);
    expect(parsePcmRateFromFormat(undefined, 8000)).toBe(8000);
  });

  it('measures peaks and drops incomplete RMS frames', () => {
    expect(pcm16lePeakAbs(Buffer.alloc(0))).toBe(0);
    expect(pcm16lePeakAbs(pcm([-32768, 1000]))).toBe(32768);
    expect(pcm16leFrameRms(pcm([3000, -3000, 10]), 2)).toEqual([3000]);
    expect(pcm16leFrameRms(pcm([1]), 0)).toEqual([]);
  });

  it('preserves NaN from fractional RMS sample indices', () => {
    const frames = pcm16leFrameRms(pcm([1, 2, 3, 4]), 1.5);
    expect(frames[0]).toBe(Math.sqrt(5 / 1.5));
    expect(frames[1]).toBeNaN();
  });

  it('reads unaligned PCM views and clips gained float samples', () => {
    const source = pcm([-32768, 8192, 32767]);
    const unaligned = Buffer.alloc(source.length + 1).subarray(1);
    source.copy(unaligned);
    expect(pcm16lePeakAbs(unaligned)).toBe(32768);
    expect(pcm16leFrameRms(unaligned, 1)).toEqual([32768, 8192, 32767]);
    expect([...pcm16leToFloat32(unaligned, 2)]).toEqual([-1, 0.5, 1]);
  });

  it('rejects odd byte lengths', () => {
    const odd = Buffer.alloc(3);
    for (const convert of [
      pcm16lePeakAbs,
      (buffer) => pcm16leFrameRms(buffer, 1),
      pcm16leToFloat32,
      (buffer) => new Pcm16MonoResampler({ inputRate: 16000, outputRate: 8000 }).processChunk(buffer),
    ]) {
      expect(() => convert(odd)).toThrow('PCM16 chunk byteLength must be even, got 3');
    }
  });

  it('wraps mono PCM without changing its bytes', () => {
    const source = pcm([1000, -1000]);
    const wav = pcm16ToWav(source, 16000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + source.length);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(source);
  });

  it('preserves resampling across empty and single-sample chunks', () => {
    const rates = { inputRate: 48000, outputRate: 16000 };
    const source = pcm([1000, -2000, 3000, -4000, 5000, -6000, 7000]);
    const whole = new Pcm16MonoResampler(rates).processChunk(source);
    const streaming = new Pcm16MonoResampler(rates);
    const split = Buffer.concat([
      streaming.processChunk(source.subarray(0, 2)),
      streaming.processChunk(Buffer.alloc(0)),
      streaming.processChunk(source.subarray(2, 8)),
      streaming.processChunk(source.subarray(8)),
    ]);
    expect(split).toEqual(whole);
    streaming.reset();
    expect(streaming.carrySample).toBeNull();
    expect(streaming.processChunk(source)).toEqual(whole);
  });
});
