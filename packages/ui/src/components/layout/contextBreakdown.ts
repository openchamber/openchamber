/**
 * The context panel's four-segment bar, as shares of the window it sits under.
 *
 * The estimate beside it walks the whole conversation and turns characters into
 * tokens; the readout above it reports what the newest turn actually filled.
 * Those are different quantities, so the bar cannot use the estimate as its own
 * denominator: on a real session the estimate is an order of magnitude larger
 * than the one turn's non-cached input, which drove the leftover category to a
 * clamped zero and made the percentages a ratio inside the estimate rather than
 * a share of the window.
 *
 * The window is therefore the denominator for every segment, and `other` is the
 * genuine remainder — the system prompt, tool and MCP schemas, skills, and the
 * error in the character estimate, none of which a per-message character count
 * can name. On a cache-heavy session the largest part of `other` is the cached
 * prompt re-read plus the turn's own output and reasoning, not the schemas. When the window is unknown (compacted, or a turn that reported no
 * tokens) the estimate is all there is and becomes its own denominator, and
 * when the estimate runs past the window the total grows to hold it so no
 * segment can exceed the bar.
 */

export type ContextBuckets = {
  user: number;
  assistant: number;
  tool: number;
  other: number;
};

type ContextBreakdown = ContextBuckets & {
  /** The denominator the segments are shares of: the window, or the estimate when it is larger. */
  total: number;
};

type BreakdownInput = {
  /** The used-window figure the readout shows (the newest turn's reported total). */
  windowTokens: number;
  /**
   * A completed compaction record can still carry the summarizing turn's
   * tokens, but the readout shows `—` because the fill is unknown. The bar
   * must not denominate against that pre-compaction window either.
   */
  compacted?: boolean;
};

/**
 * `estimate` is the whole-conversation character estimate in tokens.
 */
export const composeContextBreakdown = (
  estimate: ContextBuckets,
  { windowTokens, compacted = false }: BreakdownInput,
): ContextBreakdown => {
  const usable = compacted ? 0 : windowTokens;
  const window = Number.isFinite(usable) && usable > 0 ? usable : 0;
  const estimated = estimate.user + estimate.assistant + estimate.tool + estimate.other;
  // The window is the real fill, but a conversation longer than the model keeps
  // can estimate past it; the total grows so `other` stays a non-negative
  // remainder instead of a clamp that hides the overrun. `other` is therefore
  // `total - estimated` by construction, never negative.
  const total = Math.max(window, estimated);
  return {
    user: estimate.user,
    assistant: estimate.assistant,
    tool: estimate.tool,
    other: total - estimated,
    total,
  };
};
