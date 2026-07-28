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
  TtsStreamProcessor,
  TtsPlaybackEngine,
} from './useServerTTS';

// ─── Minimal AudioContext mock ───────────────────────────────────────────────

function createMockAudioContext() {
  const buffers: { channels: number; length: number; sampleRate: number; data: Float32Array[] }[] = [];
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
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
        duration: length / sampleRate,
        getChannelData(ch: number) {
          return data[ch];
        },
      };
      buffers.push(buf);
      return buf;
    },
    createGain() {
      return {
        gain: { value: 1.0 },
        connect: () => {},
        disconnect: () => {},
      };
    },
    createBufferSource() {
      return {
        buffer: null,
        detune: { value: 0 },
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
        onended: null as (() => void) | null,
      };
    },
    suspend: async function() { this.state = 'suspended'; },
    resume: async function() { this.state = 'running'; },
    decodeAudioData: async function(arrayBuffer: ArrayBuffer) {
      return this.createBuffer(1, 100, 24000);
    }
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

describe('TtsStreamProcessor', () => {
  test('buffers WAV chunks correctly until WAV_HEADER_SIZE is reached and yields valid PCM frames', () => {
    let pcmReadyCount = 0;
    const processor = new TtsStreamProcessor((pcmData) => {
      pcmReadyCount++;
      // Since bitsPerSample is 16 and channels is 1, block align is 2.
      // So length should be divisible by 2.
      expect(pcmData.length % 2).toBe(0);
    }, () => {});

    // Create a 44-byte WAV header
    const wavHeader = buildWavHeader(24000, 1, 16);
    
    // Feed the first 20 bytes (simulating a split chunk during streaming)
    processor.processChunk(wavHeader.slice(0, 20));
    expect(processor.formatDetected).toBe(false);
    
    // Feed the remaining 24 bytes
    processor.processChunk(wavHeader.slice(20, 44));
    expect(processor.formatDetected).toBe(true);
    expect(processor.isWav).toBe(true);

    // Feed a PCM chunk that exceeds MIN_PCM_CHUNK_BYTES (8192)
    const largeChunk = new Uint8Array(9000);
    processor.processChunk(largeChunk);
    
    // Should trigger exactly one flush
    expect(pcmReadyCount).toBe(1);
    
    // Feed a small chunk that doesn't reach the threshold
    processor.processChunk(new Uint8Array(2000));
    expect(pcmReadyCount).toBe(1); // Still 1

    // Test the remainder logic by forcing flush at stream end
    processor.flushPcm(true);
    expect(pcmReadyCount).toBe(2);
  });
  
  test('invokes fallback for non-WAV data', () => {
    let fallbackCalled = false;
    const processor = new TtsStreamProcessor(() => {}, () => {
      fallbackCalled = true;
    });

    const mp3Header = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    processor.processChunk(mp3Header);
    expect(processor.formatDetected).toBe(true);
    expect(processor.isWav).toBe(false);
    expect(fallbackCalled).toBe(true);
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

  test('handles empty PCM data', () => {
    const ctx = createMockAudioContext();
    const wavInfo: WavInfo = { sampleRate: 24000, numChannels: 1, bitsPerSample: 16 };
    const buf = pcm16ToAudioBuffer(ctx, new Uint8Array(0), wavInfo);
    expect(buf.length).toBe(0);
  });
});

describe('TtsPlaybackEngine', () => {
  test('initializes and connects gain node', () => {
    const ctx = createMockAudioContext();
    let isPlaying = false;
    const engine = new TtsPlaybackEngine(ctx, { volume: 0.8 }, (state) => isPlaying = state);
    engine.init();
    
    // Just verifying it doesn't throw and initializes properties properly
    expect(engine).toBeDefined();
  });

  test('schedules WAV chunks progressively', () => {
    const ctx = createMockAudioContext();
    const engine = new TtsPlaybackEngine(ctx, { pitch: 1.5 }, () => {});
    engine.init();
    
    const buf = ctx.createBuffer(1, 24000, 24000); // 1 second
    let startCalled = false;
    
    const originalCreateSource = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = function() {
      const source = originalCreateSource();
      source.start = (time: number) => {
        startCalled = true;
        // The first chunk should start at ctx.currentTime + 0.05
        expect(time).toBe(0.05);
      };
      return source;
    };
    
    engine.scheduleWavChunk(buf);
    expect(startCalled).toBe(true);
  });

  test('blob fallback plays entire buffer and handles onended', () => {
    const ctx = createMockAudioContext();
    let playingState = true;
    let onEndCallbackTriggered = false;
    
    const options = {
      onEnd: () => { onEndCallbackTriggered = true; }
    };
    
    const engine = new TtsPlaybackEngine(ctx, options, (state) => playingState = state);
    engine.init();
    
    const buf = ctx.createBuffer(1, 24000, 24000);
    let capturedSource: any = null;
    
    const originalCreateSource = ctx.createBufferSource.bind(ctx);
    ctx.createBufferSource = function() {
      const source = originalCreateSource();
      capturedSource = source;
      source.start = (time: number) => {
        expect(time).toBe(0); // blob fallback always starts at 0
      };
      return source;
    };
    
    engine.playBlobFallback(buf);
    
    // Simulate audio playback finishing
    expect(capturedSource.onended).toBeDefined();
    capturedSource.onended();
    
    expect(playingState).toBe(false); // isPlaying should be updated
    expect(onEndCallbackTriggered).toBe(true);
  });

  test('pause and resume toggle AudioContext state', () => {
    const ctx = createMockAudioContext();
    const engine = new TtsPlaybackEngine(ctx, {}, () => {});
    engine.init();
    
    expect(ctx.state).toBe('running');
    engine.pause();
    expect(ctx.state).toBe('suspended');
    engine.resume();
    expect(ctx.state).toBe('running');
  });

  test('stop clears sources and disconnects without throwing', () => {
    const ctx = createMockAudioContext();
    const engine = new TtsPlaybackEngine(ctx, {}, () => {});
    engine.init();
    
    const buf = ctx.createBuffer(1, 24000, 24000);
    engine.scheduleWavChunk(buf);
    
    engine.stop();
    // Subsequent calls to schedule should gracefully skip
    engine.scheduleWavChunk(buf);
  });
});
