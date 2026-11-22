// The error tail of exec-http: what a SpaceError message may carry from
// inside a container, cut to its last 2,000 characters.

import { describe, expect, it } from 'vitest';

import { tail } from './exec-http.js';

describe('exec-http tail', () => {
  it('never returns a tail that starts inside a surrogate pair (#2041)', () => {
    // Input length 2,002, so the 2,000-char cut lands between the halves
    // of the astral character: the partial character is dropped.
    const kept = tail(`x\u{1F600}${'y'.repeat(1_999)}`);
    expect(kept).toBe('y'.repeat(1_999));
    expect(new TextDecoder().decode(new TextEncoder().encode(kept))).not.toContain('\uFFFD');
  });

  it('keeps ASCII over-limit tails at exact length and under-limit text unchanged', () => {
    expect(tail('y'.repeat(5_000))).toHaveLength(2_000);
    expect(tail('hello \u{1F600}')).toBe('hello \u{1F600}');
    expect(tail(null)).toBe('');
  });
});
