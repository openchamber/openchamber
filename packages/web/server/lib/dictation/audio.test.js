import { describe, expect, it } from 'vitest';

import { trimPcm16Silence } from './audio.js';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

function msToSamples(ms) {
  return Math.round((SAMPLE_RATE * ms) / 1000);
}

/** Square tone at `amplitude`, PCM16LE mono. RMS equals the amplitude. */
function tone(ms, amplitude) {
  const samples = msToSamples(ms);
  const buffer = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * BYTES_PER_SAMPLE);
  }
  return buffer;
}

function silence(ms) {
  return Buffer.alloc(msToSamples(ms) * BYTES_PER_SAMPLE);
}

function durationMs(buffer) {
  return (buffer.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
}

describe('trimPcm16Silence', () => {
  it('keeps 500 ms speech plus about 100 ms tail from 1000 ms trailing silence', () => {
    const speech = tone(500, 8000);
    const input = Buffer.concat([speech, silence(1000)]);

    const result = trimPcm16Silence(input, { sampleRate: SAMPLE_RATE });

    expect(result.length).toBeLessThan(input.length);
    expect(durationMs(result)).toBeGreaterThanOrEqual(580);
    expect(durationMs(result)).toBeLessThanOrEqual(620);
    expect(result.subarray(0, speech.length).equals(speech)).toBe(true);
  });

  it('returns an empty buffer for 100 ms of speech, below minSpeechMs', () => {
    const input = Buffer.concat([tone(100, 8000), silence(1000)]);

    const result = trimPcm16Silence(input, { sampleRate: SAMPLE_RATE });

    expect(result.length).toBe(0);
  });

  it('returns the input buffer unchanged when neither end is silent', () => {
    const input = tone(500, 8000);

    const result = trimPcm16Silence(input, { sampleRate: SAMPLE_RATE });

    expect(result).toBe(input);
    expect(result.length).toBe(input.length);
  });

  it('cuts silence from both ends', () => {
    const speech = tone(500, 8000);
    const input = Buffer.concat([silence(500), speech, silence(500)]);

    const result = trimPcm16Silence(input, { sampleRate: SAMPLE_RATE });

    const expected = Buffer.concat([speech, silence(100)]);
    expect(result.equals(expected)).toBe(true);
    expect(durationMs(result)).toBeCloseTo(600, 5);
  });

  it('returns an empty buffer for pure silence', () => {
    const result = trimPcm16Silence(silence(1000), { sampleRate: SAMPLE_RATE });
    expect(result.length).toBe(0);
  });
});
