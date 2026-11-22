import { describe, expect, it } from 'vitest';
import { transformModelData, transformQuotaBucket } from './transforms.js';

describe('Google transforms', () => {
  it.each([
    [-0.5, 100],
    [0, 100],
    [1, 0],
    [1.5, 0]
  ])('transformQuotaBucket clamps usedPercent to [0, 100] for remainingFraction %s', (remainingFraction, expectedUsedPercent) => {
    const result = transformQuotaBucket(
      { modelId: 'gemini-2.5-pro', remainingFraction, resetTime: '2026-10-08T14:29:35Z' },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['per-model'].usedPercent).toBe(expectedUsedPercent);
  });

  it.each([
    [-0.5, 100],
    [0, 100],
    [1, 0],
    [1.5, 0]
  ])('transformModelData clamps usedPercent to [0, 100] for remainingFraction %s', (remainingFraction, expectedUsedPercent) => {
    const result = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction, resetTime: '2026-10-08T14:29:35Z' } },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['per-model'].usedPercent).toBe(expectedUsedPercent);
  });

  it('transformModelData returns the parsed resetAt for a valid resetTime', () => {
    const result = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-08T14:29:35Z' } },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['per-model'].resetAt).toBe(Date.parse('2026-10-08T14:29:35Z'));
  });

  it('transformModelData returns resetAt null for an unparseable resetTime', () => {
    const result = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: 'not-a-date' } },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['per-model'].resetAt).toBeNull();
  });

  it.each([
    ['missing resetTime', { quotaInfo: { remainingFraction: 0.5 } }],
    ['missing quotaInfo', {}],
    ['missing modelData', undefined]
  ])('transformModelData returns resetAt null for %s', (_label, modelData) => {
    const result = transformModelData('gemini-2.5-pro', modelData, 'google');

    expect(result['google/gemini-2.5-pro'].windows['per-model'].resetAt).toBeNull();
  });

  it('transformModelData does not double-prefix an already scoped model name', () => {
    const result = transformModelData(
      'google/gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-08T14:29:35Z' } },
      'google'
    );

    expect(Object.keys(result)).toEqual(['google/gemini-2.5-pro']);
  });

  it.each([
    ['2026-10-08T14:29:35Z', Date.parse('2026-10-08T14:29:35Z')],
    ['not-a-date', null],
    [undefined, null]
  ])('transformQuotaBucket returns resetAt %s -> %s', (resetTime, expectedResetAt) => {
    const result = transformQuotaBucket(
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['per-model'].resetAt).toBe(expectedResetAt);
  });

  it('stamps no fabricated daily window: the per-model window claims no duration (#1042)', () => {
    const bucket = transformQuotaBucket(
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime: '2026-10-08T14:29:35Z' },
      'gemini'
    );
    expect(Object.keys(bucket['gemini/gemini-2.5-pro'].windows)).toEqual(['per-model']);
    expect(bucket['gemini/gemini-2.5-pro'].windows['per-model'].windowSeconds).toBeNull();

    const model = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-08T14:29:35Z' } },
      'gemini'
    );
    expect(Object.keys(model['gemini/gemini-2.5-pro'].windows)).toEqual(['per-model']);
    expect(model['gemini/gemini-2.5-pro'].windows['per-model'].windowSeconds).toBeNull();
  });
});
