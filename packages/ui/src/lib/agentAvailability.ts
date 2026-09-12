import type { Agent } from '@opencode-ai/sdk/v2';

/**
 * Whether a requested agent can be sent for a directory.
 *
 * `missing` is only reported against an agent list that has actually loaded:
 * a list that was never loaded cannot prove absence, so the request stays
 * `unknown` and callers keep their current behavior (fail open).
 */
export type AgentAvailabilityReason = 'available' | 'missing' | 'unknown';

export interface AgentAvailability {
  /** Agent name a send may carry; absent when the requested agent is unavailable. */
  agent?: string;
  reason: AgentAvailabilityReason;
}

/**
 * Resolve a requested agent against one directory's already-loaded agent list.
 *
 * Pure by design: the caller owns store and network access, so the decision is
 * unit-testable and every send route makes it the same way.
 */
export const resolveAgentAvailability = (
  requestedAgent: string | null | undefined,
  directoryAgents: readonly Pick<Agent, 'name'>[] | null | undefined,
): AgentAvailability => {
  const requested = requestedAgent?.trim() ?? '';
  if (!requested) {
    return { reason: 'unknown' };
  }

  if (directoryAgents == null) {
    return { agent: requested, reason: 'unknown' };
  }

  if (directoryAgents.some((agent) => agent.name === requested)) {
    return { agent: requested, reason: 'available' };
  }

  return { reason: 'missing' };
};
