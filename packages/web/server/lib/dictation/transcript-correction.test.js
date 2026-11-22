import { describe, expect, it } from 'vitest';

import { createTranscriptCorrector, isPlausibleCorrection } from './transcript-correction.js';

describe('createTranscriptCorrector', () => {
  it('returns the model text and tells it the language', async () => {
    const calls = [];
    const correct = createTranscriptCorrector({
      generate: async (args) => {
        calls.push(args);
        return { text: ' Який їхав, такий і здибав. ' };
      },
    });
    expect(await correct('Який їхав, таку з дибав', { language: 'uk' })).toBe('Який їхав, такий і здибав.');
    expect(calls[0].prompt).toContain('"uk"');
    expect(calls[0].prompt).toContain('таку з дибав');
    expect(calls[0].onOverflow).toBe('error');
  });

  it('keeps the original when the model fails or answers instead of fixing', async () => {
    const failing = createTranscriptCorrector({ generate: async () => { throw new Error('no small model'); } });
    expect(await failing('hello there')).toBe('hello there');

    const chatty = createTranscriptCorrector({
      generate: async () => ({ text: 'Sure! Here is the corrected version of your dictated text: hello there' }),
    });
    expect(await chatty('hello there')).toBe('hello there');
  });

  it('returns the original when the whole pass outlives its deadline', async () => {
    let signal;
    const correct = createTranscriptCorrector({
      timeoutMs: 20,
      generate: (args) => {
        signal = args.signal;
        return new Promise(() => {});
      },
    });
    expect(await correct('hello there')).toBe('hello there');
    expect(signal.aborted).toBe(true);
  });

  it('skips the model for empty text', async () => {
    let called = false;
    const correct = createTranscriptCorrector({ generate: async () => { called = true; return { text: 'x' }; } });
    expect(await correct('  ')).toBe('  ');
    expect(called).toBe(false);
  });
});

describe('isPlausibleCorrection', () => {
  it('accepts a copy of about the same length', () => {
    expect(isPlausibleCorrection('I am uh a passive house consultant', 'I am a passive house consultant.')).toBe(true);
  });

  it('rejects empty, much shorter or much longer answers', () => {
    expect(isPlausibleCorrection('hello there friend', '')).toBe(false);
    expect(isPlausibleCorrection('a long sentence about the cost of passive houses', 'ok')).toBe(false);
    expect(isPlausibleCorrection('hi', 'hi, how can I help you today?')).toBe(false);
  });
});
