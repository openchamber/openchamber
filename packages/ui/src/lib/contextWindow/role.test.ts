import { describe, expect, test } from 'bun:test';
import { buildContextWindowUrl, isContextWindowUrl } from './role';

describe('context window url', () => {
  const owner = '3fd32f04-267f-4e4d-9005-f505c6ef43f9';
  const origin = 'http://localhost:3000';

  test('a window found by name is the panel only when it shows this owner\'s panel page', () => {
    expect(isContextWindowUrl(buildContextWindowUrl(`${origin}/?session=abc`, owner), owner, origin)).toBe(true);
    expect(isContextWindowUrl(buildContextWindowUrl(`${origin}/`, 'other-owner-id'), owner, origin)).toBe(false);
    expect(isContextWindowUrl(`${origin}/?session=abc`, owner, origin)).toBe(false);
    expect(isContextWindowUrl('about:blank', owner, origin)).toBe(false);
    expect(isContextWindowUrl(`https://example.com/?contextWindow=${owner}`, owner, origin)).toBe(false);
  });
});
