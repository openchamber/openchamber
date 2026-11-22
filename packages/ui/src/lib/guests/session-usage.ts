import type { GuestSessionContext } from '@openchamber/sdk';
import type { Session } from '@/lib/opencode/model';
import { findLatestContextFill, type ContextFillMessage } from '@/stores/utils/tokenUtils';
import { computeSessionTokenTotals } from '@/components/chat/work-status/contextUsage';
import { limitsForAnsweringModel } from '@/lib/routing/contextWindowLimits';
import { guestSessionModelId } from './host-bridge';

type FrameSessionFields = {
  id?: string;
  title?: string;
  model?: string;
  agent?: string;
  tokens: ReturnType<typeof computeSessionTokenTotals>;
};

export const frameSessionFields = (session: Session | undefined): FrameSessionFields => ({
  id: session?.id,
  title: session?.title,
  model: guestSessionModelId(session?.model),
  agent: session?.agent,
  tokens: computeSessionTokenTotals(session),
});

export const sameFrameSessionFields = (left: FrameSessionFields, right: FrameSessionFields): boolean => (
  left.id === right.id && left.title === right.title && left.model === right.model && left.agent === right.agent
  && (left.tokens === right.tokens || (!left.tokens && !right.tokens) || Boolean(left.tokens && right.tokens
    && left.tokens.prompt === right.tokens.prompt && left.tokens.output === right.tokens.output
    && left.tokens.reasoning === right.tokens.reasoning && left.tokens.cacheRead === right.tokens.cacheRead
    && left.tokens.cacheWrite === right.tokens.cacheWrite && left.tokens.cacheHitPercent === right.tokens.cacheHitPercent))
);

type FrameContextMessage = ContextFillMessage & { providerID?: string; modelID?: string };

type FrameContextReading = { tokens: number; model: string | null };

export const selectFrameContextReading = (messages: readonly FrameContextMessage[]): FrameContextReading | null => {
  const fill = findLatestContextFill(messages);
  if (fill?.state !== 'measured') return null;
  const step = messages[fill.index];
  return { tokens: fill.totalTokens, model: step?.providerID && step.modelID ? `${step.providerID}/${step.modelID}` : null };
};

export const sameFrameContextReading = (left: FrameContextReading | null, right: FrameContextReading | null): boolean => (
  left === right || (left !== null && right !== null && left.tokens === right.tokens && left.model === right.model)
);

export const frameContextLimit = (
  reading: FrameContextReading | null,
  providers: Parameters<typeof limitsForAnsweringModel>[1],
): number | null => {
  if (!reading) return null;
  const limit = limitsForAnsweringModel(reading.model, providers).context;
  return limit > 0 ? limit : null;
};

export const frameContext = (reading: FrameContextReading | null, limit: number | null): GuestSessionContext | null => (
  reading ? { tokens: reading.tokens, limit } : null
);
