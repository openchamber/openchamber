
export type ContextBuckets = {
  user: number;
  assistant: number;
  tool: number;
  other: number;
};

type ContextBreakdown = ContextBuckets & {
  total: number;
};

type BreakdownInput = {
  windowTokens: number;
  compacted?: boolean;
};

export const composeContextBreakdown = (
  estimate: ContextBuckets,
  { windowTokens, compacted = false }: BreakdownInput,
): ContextBreakdown => {
  const usable = compacted ? 0 : windowTokens;
  const window = Number.isFinite(usable) && usable > 0 ? usable : 0;
  const estimated = estimate.user + estimate.assistant + estimate.tool + estimate.other;
  const total = Math.max(window, estimated);
  return {
    user: estimate.user,
    assistant: estimate.assistant,
    tool: estimate.tool,
    other: total - estimated,
    total,
  };
};
