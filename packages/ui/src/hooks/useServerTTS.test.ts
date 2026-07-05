/**
 * Tests for WAV streaming helpers extracted from useServerTTS.
 *
 * Testing convention: pure functions only, no hook rendering.
 * Mock AudioContext minimally for pcm16ToAudioBuffer.
 */

import { describe, expect, test } from 'bun:test';
import {
  WAV_HEADER_SIZE,
  parseWavHeader,
  pcm16ToAudioBuffer,
  concatUint8,
  type WavInfo,
} from './useServerTTS';

// ─── Minimal AudioContext mock ───────────────────────────────────────────────

function createMockAudioContext() {
  const buffers: { channels: number; length: number; sampleRate: number; data: Float32Array[] }[] = [];
  return {
    createBuffer(channels: number, length: number, sampleRate: number) {
      const data: Float32Array[] = [];
      for (let i = 0; i < channels; i++) {
        data.push(new Float32Array(length));
      }
      const buf = {
        channels,
        numberOfChannels: channels,
        length,
        sampleRate,
        data,
        getChannelData(ch: number) {
          return data[ch];
        },
      };
      buffers.push(buf);
      return buf;
    },
  } as unknown as AudioContext;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal WAV header (44 bytes) for testing */
function buildWavHeader(sampleRate: number, numChannels: number, bitsPerSample: number): Uint8Array {
  const buf = new Uint8Array(WAV_HEADER_SIZE);
  const view = new DataView(buf.buffer);
  // RIFF
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36, true); // file size - 8
  buf.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  buf.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true); // byte rate
  view.setUint16(32, numChannels * bitsPerSample / 8, true); // block align
  view.setUint16(34, bitsPerSample, true);
  buf.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, 0, true); // data size (unknown for streaming)
  return buf;
}

/** Build WAV header + PCM data */
function buildWavFile(pcmData: Int16Array, sampleRate = 24000, numChannels = 1): Uint8Array {
  const header = buildWavHeader(sampleRate, numChannels, 16);
  const pcm = new Uint8Array(pcmData.buffer.slice(0));
  return concatUint8(header, pcm);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('parseWavHeader', () => {
  test('parses a valid WAV header', () => {
    const header = buildWavHeader(24000, 1, 16);
    const info = parseWavHeader(header);
    expect(info).not.toBeNull();
    expect(info!.sampleRate).toBe(24000);
    expect(info!.numChannels).toBe(1);
    expect(info!.bitsPerSample).toBe(16);
  });

  test('parses stereo 48kHz header', () => {
    const header = buildWavHeader(48000, 2, 16);
    const info = parseWavHeader(header);
    expect(info).not.toBeNull();
    expect(info!.sampleRate).toBe(48000);
    expect(info!.numChannels).toBe(2);
  });

  test('returns null for non-WAV data', () => {
    const mp3Data = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
    expect(parseWavHeader(mp3Data)).toBeNull();
  });

  test('returns null for data shorter than 44 bytes', () => {
    const short = new Uint8Array(20);
    expect(parseWavHeader(short)).toBeNull();
  });
});

describe('pcm16ToAudioBuffer', () => {
  test('converts PCM int16 to float32 AudioBuffer', () => {
    const ctx = createMockAudioContext();
    const wavInfo: WavInfo = { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
    // Two samples: max amplitude and silence
    const pcm = new ArrayBuffer(4);
    const view = new DataView(pcm);
    view.setInt16(0, 32767, true); // max positive
    view.setInt16(2, 0, true); // silence

    const buf = pcm16ToAudioBuffer(ctx, new Uint8Array(pcm), wavInfo);
    expect(buf.length).toBe(2);
    expect(buf.sampleRate).toBe(24000);
    expect(buf.numberOfChannels).toBe(1);
    // Max int16 → ~1.0 in float32
    expect(buf.getChannelData(0)[0]).toBe(32767 / 32768);
    expect(buf.getChannelData(0)[1]).toBe(0);
  });

  test('handles negative samples correctly', () => {
    const ctx = createMockAudioContext();
    const wavInfo: WavInfo = { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
    const pcm = new ArrayBuffer(2);
    new DataView(pcm).setInt16(0, -32768, true); // max negative

    const buf = pcm16ToAudioBuffer(ctx, new Uint8Array(pcm), wavInfo);
    expect(buf.getChannelData(0)[0]).toBe(-1);
  });

  test('handles stereo data', () => {
    const ctx = createMockAudioContext();
    const wavInfo: WavInfo = { sampleRate: 24000, numChannels: 2, bitsPerSample: 16 };
    // 1 frame: left=1000, right=2000
    const pcm = new ArrayBuffer(4);
    const view = new DataView(pcm);
    view.setInt16(0, 1000, true);
    view.setInt16(2, 2000, true);

    const buf = pcm16ToAudioBuffer(ctx, new Uint8Array(pcm), wavInfo);
    expect(buf.numberOfChannels).toBe(2);
    expect(buf.length).toBe(1);
    expect(buf.getChannelData(0)[0]).toBe(1000 / 32768);
    expect(buf.getChannelData(1)[0]).toBe(2000 / 32768);
  });

  test('handles empty PCM data', () => {
    const ctx = createMockAudioContext();
    const wavInfo: WavInfo = { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
    const buf = pcm16ToAudioBuffer(ctx, new Uint8Array(0), wavInfo);
    expect(buf.length).toBe(0);
  });
});

describe('concatUint8', () => {
  test('concatenates two arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const result = concatUint8(a, b);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  test('handles empty arrays', () => {
    const result1 = concatUint8(new Uint8Array(0), new Uint8Array([1, 2]));
    expect(Array.from(result1)).toEqual([1, 2]);

    const result2 = concatUint8(new Uint8Array([1, 2]), new Uint8Array(0));
    expect(Array.from(result2)).toEqual([1, 2]);

    const result3 = concatUint8(new Uint8Array(0), new Uint8Array(0));
    expect(result3.length).toBe(0);
  });

  test('does not modify input arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    concatUint8(a, b);
    expect(Array.from(a)).toEqual([1, 2, 3]);
    expect(Array.from(b)).toEqual([4, 5]);
  });
});

describe('WAV format detection integration', () => {
  test('full WAV file: header parsing + PCM extraction + AudioBuffer conversion', () => {
    const samples = new Int16Array([100, -100, 32767, -32768, 0]);
    const wavFile = buildWavFile(samples);

    // Split into header + PCM (simulating streaming chunks)
    const header = wavFile.slice(0, WAV_HEADER_SIZE);
    const pcm = wavFile.slice(WAV_HEADER_SIZE);

    // Parse header
    const info = parseWavHeader(header);
    expect(info).not.toBeNull();
    expect(info!.sampleRate).toBe(24000);
    expect(info!.numChannels).toBe(1);

    // Convert PCM
    const ctx = createMockAudioContext();
    const audioBuffer = pcm16ToAudioBuffer(ctx, pcm, info!);
    expect(audioBuffer.length).toBe(5);
    expect(audioBuffer.getChannelData(0)[0]).toBe(100 / 32768);
    expect(audioBuffer.getChannelData(0)[2]).toBe(32767 / 32768);
    expect(audioBuffer.getChannelData(0)[3]).toBe(-1);
  });

  test('detects non-WAV format from first bytes', () => {
    const mp3Header = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const info = parseWavHeader(concatUint8(mp3Header, new Uint8Array(40)));
    expect(info).toBeNull();
  });
});
