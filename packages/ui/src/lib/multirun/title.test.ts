import { describe, expect, test } from 'bun:test';

import { getFusionSessionTitle, getMultiRunSessionTitle, parseMultiRunSessionTitle } from './title';

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
