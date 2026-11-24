import type { SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget, SourceControlProjectRef } from '@openchamber/sdk';
import { isBoolean, isRecord } from '../shared/guards.js';
import type { MutationContextInput } from '../source-control/binding-service-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';
import type { GitLabMappedIssue, GitLabMappedMergeRequest } from './mappers.js';

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['Projects']['show']>>;
type NumberedTarget = { projectId: string; number: number };
type Resolved = { providerTarget: NumberedTarget; target: SourceControlMutationTarget };
type InvalidMutationContext = (message: string) => Error;
type Outcome = { state: string; result?: object };
type Digest = Record<string, SourceControlJson | undefined>;
type ConversationFlags = { writeAccess?: boolean; locked?: boolean; viewerSubscribed?: boolean };

const DEVELOPER_ACCESS_LEVEL = 30;

const fieldsOf = <Value>(value: Value): JsonObject | null => {
  if (!isRecord(value)) return null;
  // SAFETY: provider payloads and client failures are objects; every field read below is re-checked before use.
  return value as JsonObject;
};

const statusOf = (value: JsonValue | undefined) => (Number.isInteger(value) ? Number(value) : undefined);

const requestStatus = (cause: unknown) => {
  const error = fieldsOf(cause);
  const nested = fieldsOf(error?.cause);
  return statusOf(fieldsOf(nested?.response)?.status)
    ?? statusOf(fieldsOf(error?.response)?.status)
    ?? statusOf(error?.status);
};

const accessLevel = (value: JsonObject | null) => {
  const level = value?.access_level;
  return Number.isInteger(level) ? Number(level) : undefined;
};

const gitlabWriteAccess = <ProjectRaw>(projectRaw: ProjectRaw) => {
  const permissions = fieldsOf(fieldsOf(projectRaw)?.permissions);
  if (!permissions) return undefined;
  const levels = [accessLevel(fieldsOf(permissions.project_access)), accessLevel(fieldsOf(permissions.group_access))]
    .filter((level): level is number => level !== undefined);
  if (!levels.length) return undefined;
  return levels.some((level) => level >= DEVELOPER_ACCESS_LEVEL);
};

const gitlabLockFlag = <ItemRaw>(itemRaw: ItemRaw) => {
  const item = fieldsOf(itemRaw);
  if (!item || !Object.hasOwn(item, 'discussion_locked')) return undefined;
  if (item.discussion_locked === null) return false;
  return isBoolean(item.discussion_locked) ? item.discussion_locked : undefined;
};

const gitlabSubscriptionFlag = <ItemRaw>(itemRaw: ItemRaw) => {
  const subscribed = fieldsOf(itemRaw)?.subscribed;
  return isBoolean(subscribed) ? subscribed : undefined;
};

export const gitlabConversationFlags = <Value, ProjectRaw, ItemRaw>(
  value: Value, projectRaw: ProjectRaw, itemRaw: ItemRaw,
): Value & ConversationFlags => {
  const flags: ConversationFlags = {};
  const writeAccess = gitlabWriteAccess(projectRaw);
  if (writeAccess !== undefined) flags.writeAccess = writeAccess;
  const locked = gitlabLockFlag(itemRaw);
  if (locked !== undefined) flags.locked = locked;
  const subscribed = gitlabSubscriptionFlag(itemRaw);
  if (subscribed !== undefined) flags.viewerSubscribed = subscribed;
  return { ...value, ...flags };
};

interface ConversationWriteDeps {
  client: Pick<Client, 'Issues' | 'MergeRequests'>;
  requireIssue<P extends SourceControlProjectRef>(raw: Reply, project: P): GitLabMappedIssue<P>;
  requireMutationResponse(
    raw: Reply, project: SourceControlProjectRef, providerTarget: NumberedTarget, expected?: SourceControlMutationTarget,
  ): GitLabMappedMergeRequest<SourceControlProjectRef>;
  mutationTargetInvalid(message: string): Error;
}

export const gitlabConversationWrites = (deps: ConversationWriteDeps) => {
  const { client, requireIssue, requireMutationResponse, mutationTargetInvalid } = deps;

  return {
    async setConversationLock(payload: {
      kind: string; locked: boolean; providerTarget: NumberedTarget;
      targetProject: SourceControlProjectRef; expectedTarget: SourceControlMutationTarget;
    }) {
      const { projectId, number } = payload.providerTarget;
      const raw = payload.kind === 'issue-lock'
        ? await client.Issues.edit(projectId, number, { discussionLocked: payload.locked })
        : await client.MergeRequests.edit(projectId, number, { discussionLocked: payload.locked });
      const target = payload.kind === 'issue-lock'
        ? requireIssue(raw, payload.targetProject)
        : requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
      if (target.number !== number) throw mutationTargetInvalid('GitLab answered another target for the lock write');
      if (fieldsOf(raw)?.discussion_locked !== payload.locked) throw mutationTargetInvalid('GitLab returned an unexpected lock state');
      return {};
    },

    async reconcileLockMutation(providerTarget: NumberedTarget, kind: string, locked: boolean): Promise<Outcome> {
      const { projectId, number } = providerTarget;
      const raw = kind === 'issue-lock'
        ? await client.Issues.show(number, { projectId })
        : await client.MergeRequests.show(projectId, number);
      return fieldsOf(raw)?.discussion_locked === locked ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async setConversationSubscription(payload: {
      kind: string; subscribed: boolean; providerTarget: NumberedTarget;
      targetProject: SourceControlProjectRef; expectedTarget: SourceControlMutationTarget;
    }) {
      const { projectId, number } = payload.providerTarget;
      const readBack = async () => (payload.kind === 'issue-subscription'
        ? client.Issues.show(number, { projectId })
        : client.MergeRequests.show(projectId, number));
      let raw;
      try {
        raw = payload.kind === 'issue-subscription'
          ? await (payload.subscribed ? client.Issues.subscribe(projectId, number) : client.Issues.unsubscribe(projectId, number))
          : await (payload.subscribed ? client.MergeRequests.subscribe(projectId, number) : client.MergeRequests.unsubscribe(projectId, number));
      } catch (error) {
        if (requestStatus(error) !== 304) throw error;
        if (fieldsOf(await readBack())?.subscribed !== payload.subscribed) {
          throw mutationTargetInvalid('GitLab returned an unexpected subscription state');
        }
        return {};
      }
      const target = payload.kind === 'issue-subscription'
        ? requireIssue(raw, payload.targetProject)
        : requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
      if (target.number !== number) throw mutationTargetInvalid('GitLab answered another target for the subscription write');
      if (fieldsOf(raw)?.subscribed !== payload.subscribed) throw mutationTargetInvalid('GitLab returned an unexpected subscription state');
      return {};
    },

    async reconcileSubscriptionMutation(providerTarget: NumberedTarget, kind: string, subscribed: boolean): Promise<Outcome> {
      const { projectId, number } = providerTarget;
      const raw = kind === 'issue-subscription'
        ? await client.Issues.show(number, { projectId })
        : await client.MergeRequests.show(projectId, number);
      return fieldsOf(raw)?.subscribed === subscribed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },
  };
};

type Service = ReturnType<typeof gitlabConversationWrites>;

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
