import { describe, expect, test } from 'bun:test';

import { clampMultiRunTitle, getFusionSessionTitle, getMultiRunSessionTitle, parseMultiRunSessionTitle } from './title';

describe('multi-run titles', () => {
  test('parses legacy session titles', () => {
    expect(parseMultiRunSessionTitle('bench/anthropic/claude')).toEqual({
      groupSlug: 'bench',
      providerID: 'anthropic',
      modelID: 'claude',
      fusion: false,
    });

    expect(parseMultiRunSessionTitle('bench/anthropic/claude/2')).toEqual({
      groupSlug: 'bench',
      providerID: 'anthropic',
      modelID: 'claude',
      index: 2,
      fusion: false,
    });
  });

  test('parses grouped session titles', () => {
    expect(parseMultiRunSessionTitle('bench/g2/anthropic/claude')).toEqual({
      groupSlug: 'bench',
      runGroup: 'g2',
      providerID: 'anthropic',
      modelID: 'claude',
      fusion: false,
    });

    expect(parseMultiRunSessionTitle('bench/g2/anthropic/claude/3')).toEqual({
      groupSlug: 'bench',
      runGroup: 'g2',
      providerID: 'anthropic',
      modelID: 'claude',
      index: 3,
      fusion: false,
    });
  });

  test('keeps fusion titles scoped to the run group', () => {
    expect(getFusionSessionTitle('bench', 'anthropic', 'claude')).toBe('bench/anthropic/claude/fusion');
    expect(getFusionSessionTitle('bench', 'anthropic', 'claude', 'g2')).toBe('bench/g2/anthropic/claude/fusion');
    expect(parseMultiRunSessionTitle('bench/g2/anthropic/claude/fusion')).toEqual({
      groupSlug: 'bench',
      runGroup: 'g2',
      providerID: 'anthropic',
      modelID: 'claude',
      fusion: true,
    });
  });

  test('clamps a run title on a pair boundary (oracle: UTF-8 round-trip has no U+FFFD)', () => {
    const straddle = `${'a'.repeat(199)}😀tail`;
    const clamped = clampMultiRunTitle(straddle);

    // A cut at 200 keeps the high half of the emoji; the guard drops it.
    expect(clamped).toBe('a'.repeat(199));
    expect(clamped.length).toBeLessThanOrEqual(200);
    // A lone surrogate would become U+FFFD on the UTF-8 round-trip.
    expect(new TextDecoder().decode(new TextEncoder().encode(clamped))).toBe(clamped);
    expect(/[\uD800-\uDBFF]$/.test(clamped)).toBe(false);
  });

  test('keeps an astral character that ends exactly at the cap', () => {
    const exact = `${'a'.repeat(198)}😀tail`;

    expect(clampMultiRunTitle(exact)).toBe(`${'a'.repeat(198)}😀`);
  });

  test('clamps ASCII at the cap and trims surrounding whitespace', () => {
    expect(clampMultiRunTitle(`${'a'.repeat(200)}b`)).toBe('a'.repeat(200));
    expect(clampMultiRunTitle('  bench run  ')).toBe('bench run');
  });

  test('builds duplicate titles without empty group segments', () => {
    expect(getMultiRunSessionTitle({ groupSlug: 'bench', providerID: 'anthropic', modelID: 'claude', index: 1 })).toBe('bench/anthropic/claude/1');
    expect(getMultiRunSessionTitle({ groupSlug: 'bench', runGroup: 'g1', providerID: 'anthropic', modelID: 'claude', index: 1 })).toBe('bench/g1/anthropic/claude/1');
    expect(parseMultiRunSessionTitle('bench//anthropic/claude/1')).toEqual({
      groupSlug: 'bench',
      providerID: 'anthropic',
      modelID: 'claude',
      index: 1,
      fusion: false,
    });
  });
});
