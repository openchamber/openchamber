import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationContextInput } from '../source-control/binding-service-contracts.js';
import type { createGitLabResourceService } from './resources.js';

type Service = ReturnType<typeof createGitLabResourceService>;
type Resolved = { providerTarget: { projectId: string; number: number }; target: SourceControlMutationTarget };
type InvalidMutationContext = (message: string) => Error;
type Outcome = { state: string; result?: object };
type Digest = Record<string, SourceControlJson | undefined>;
type Entry<Value> = {
  kind: string;
  normalize(input: SourceControlJsonObject, context: MutationContextInput): Value & { digest: Digest };
  perform(service: Service, normalized: Value, resolved: Resolved): Promise<object>;
  reconcile(service: Service, resolved: Resolved, normalized: Value): Outcome | Promise<Outcome>;
};

const lockEntry = (kind: string, invalidMutationContext: InvalidMutationContext): Entry<{ locked: boolean }> => ({
  kind,
  normalize: (input, context) => {
    if (!context.target.number || (input.locked !== true && input.locked !== false)) {
      throw invalidMutationContext('target number and locked are required');
    }
    return { locked: input.locked, digest: { locked: input.locked } };
  },
  perform: (service, normalized, resolved) => service.setConversationLock({
    kind,
    locked: normalized.locked,
    providerTarget: resolved.providerTarget,
    targetProject: resolved.target.project,
    expectedTarget: resolved.target,
  }),
  reconcile: (service, resolved, normalized) => service.reconcileLockMutation(resolved.providerTarget, kind, normalized.locked),
});

const subscriptionEntry = (kind: string, invalidMutationContext: InvalidMutationContext): Entry<{ subscribed: boolean }> => ({
  kind,
  normalize: (input, context) => {
    if (!context.target.number || (input.subscribed !== true && input.subscribed !== false)) {
      throw invalidMutationContext('target number and subscribed are required');
    }
    return { subscribed: input.subscribed, digest: { subscribed: input.subscribed } };
  },
  perform: (service, normalized, resolved) => service.setConversationSubscription({
    kind,
    subscribed: normalized.subscribed,
    providerTarget: resolved.providerTarget,
    targetProject: resolved.target.project,
    expectedTarget: resolved.target,
  }),
  reconcile: (service, resolved, normalized) => service.reconcileSubscriptionMutation(resolved.providerTarget, kind, normalized.subscribed),
});

export const conversationEntries = (invalidMutationContext: InvalidMutationContext) => ({
  '/pr/lock': lockEntry('change-request-lock', invalidMutationContext),
  '/issues/lock': lockEntry('issue-lock', invalidMutationContext),
  '/pr/subscription': subscriptionEntry('change-request-subscription', invalidMutationContext),
  '/issues/subscription': subscriptionEntry('issue-subscription', invalidMutationContext),
});
