import { describe, expect, test } from 'bun:test';
import { composeContextBreakdown } from './contextBreakdown';

const estimate = (user: number, assistant: number, tool: number) => ({ user, assistant, tool, other: 0 });

describe('composeContextBreakdown', () => {
  test('measures every segment against the window the readout reports', () => {
    // The estimate is a whole-conversation character count; the window is what
    // the last turn actually filled. Both sides of the bar now share the window
    // as denominator, so the four segments add up to it.
    const breakdown = composeContextBreakdown(estimate(100, 200, 300), { windowTokens: 1000 });
    expect(breakdown).toEqual({ user: 100, assistant: 200, tool: 300, other: 400, total: 1000 });
  });

  test('reports the unattributed remainder as other instead of clamping it to zero', () => {
    // System prompt, tool and MCP schemas, skills and estimation error are real
    // window cost the per-message estimate cannot name. Folding them into a
    // clamp made other structurally 0%.
    const breakdown = composeContextBreakdown(estimate(50, 50, 50), { windowTokens: 100_000 });
    expect(breakdown.other).toBe(99_850);
    expect(breakdown.total).toBe(100_000);
  });

  test('grows the denominator to the estimate so no segment passes the window', () => {
    // A conversation longer than the model keeps can estimate past the window;
    // other must stay a non-negative remainder, never a negative one.
    const breakdown = composeContextBreakdown(estimate(400, 400, 400), { windowTokens: 500 });
    expect(breakdown.other).toBe(0);
    expect(breakdown.total).toBe(1200);
  });

  test('falls back to the estimate when the window is unknown', () => {
    // A turn that reported no tokens: the estimate is all there is.
    const breakdown = composeContextBreakdown(estimate(10, 20, 30), { windowTokens: 0 });
    expect(breakdown).toEqual({ user: 10, assistant: 20, tool: 30, other: 0, total: 60 });
  });

  test('ignores a carried-over window after a compaction', () => {
    // A completed compaction record keeps the summarizing turn's tokens, but
    // the readout above the bar shows `—`: the fill is unknown, so the bar
    // measures the estimate instead of the pre-compaction window.
    const breakdown = composeContextBreakdown(estimate(10, 20, 30), { windowTokens: 900_000, compacted: true });
    expect(breakdown).toEqual({ user: 10, assistant: 20, tool: 30, other: 0, total: 60 });
  });
});
