import type { SourceControlMutationTarget, SourceControlProjectRef } from '@openchamber/sdk';
import { isBoolean, isRecord, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';
import type { GitLabIdentity, GitLabMappedIssue, GitLabMappedMergeRequest, GitLabMappedUser, GitLabPayload } from './mappers.js';

const DEVELOPER_ACCESS_LEVEL = 30;

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['Projects']['show']>>;
type MapUser = (value: GitLabPayload | null | undefined, identity: GitLabIdentity) => GitLabMappedUser | null;
type NumberedTarget = { projectId: string; number: number };
type Outcome = { state: string; result?: object };
type Service = Pick<Client, 'Issues' | 'MergeRequests'>;

interface ProjectWithRaw { project: SourceControlProjectRef }
interface ItemWriteDeps {
  client: Service;
  showProject(path: string): Promise<ProjectWithRaw>;
  requireIssue<P extends SourceControlProjectRef>(raw: Reply, project: P): GitLabMappedIssue<P>;
  requireMutationResponse(
    raw: Reply, project: SourceControlProjectRef, providerTarget: NumberedTarget, expected?: SourceControlMutationTarget,
  ): GitLabMappedMergeRequest<SourceControlProjectRef>;
  requireMutationMergeRequest<P extends SourceControlProjectRef>(raw: Reply, project: P): GitLabMappedMergeRequest<P>;
  mutationTargetInvalid(message: string): Error;
}

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

type ItemFlags = { locked?: boolean; subscribed?: boolean; writeAccess?: boolean };

export const gitlabItemFlags = <Value, ProjectRaw, ItemRaw>(value: Value, projectRaw: ProjectRaw, itemRaw: ItemRaw): Value & ItemFlags => {
  const flags: ItemFlags = {};
  const writeAccess = gitlabWriteAccess(projectRaw);
  if (writeAccess !== undefined) flags.writeAccess = writeAccess;
  const locked = gitlabLockFlag(itemRaw);
  if (locked !== undefined) flags.locked = locked;
  const subscribed = gitlabSubscriptionFlag(itemRaw);
  if (subscribed !== undefined) flags.subscribed = subscribed;
  return { ...value, ...flags };
};

const gitlabAssignees = <Users>(users: Users, identity: GitLabIdentity, mapUser: MapUser) =>
  (Array.isArray(users) ? users : []).flatMap((user) => {
    const mapped = mapUser(fieldsOf(user) ?? undefined, identity);
    if (!mapped) return [];
    const assignee = { id: mapped.id, login: mapped.username };
    return [mapped.avatarUrl ? { ...assignee, avatarUrl: mapped.avatarUrl } : assignee];
  });

export const gitlabPeople = <ReplyValue>(raw: ReplyValue, identity: GitLabIdentity, mapUser: MapUser) => {
  const item = fieldsOf(raw);
  const reviewers = Array.isArray(item?.reviewers) ? item.reviewers : [];
  return {
    reviewers: reviewers.flatMap((user) => {
      const mapped = mapUser(fieldsOf(user) ?? undefined, identity);
      return mapped ? [mapped] : [];
    }),
    assignees: gitlabAssignees(item?.assignees, identity, mapUser),
  };
};

export const gitlabItemWrites = (deps: ItemWriteDeps) => {
  const { client, showProject, requireIssue, requireMutationResponse, requireMutationMergeRequest, mutationTargetInvalid } = deps;

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

    async setIssueAssignees(payload: {
      assignees: string[]; providerTarget: NumberedTarget;
      targetProject: SourceControlProjectRef; expectedTarget: SourceControlMutationTarget;
    }) {
      const { projectId, number } = payload.providerTarget;
      const ids = payload.assignees.map(Number);
      const issue = requireIssue(await client.Issues.edit(projectId, number, { assigneeIds: ids }), payload.targetProject);
      if (issue.number !== number) throw new Error('GitLab returned an unexpected issue');
      const answered = (issue.assignees ?? []).flatMap((user) => (user ? [Number(user.id)] : []));
      if (answered.length !== ids.length || !answered.every((id) => ids.includes(id))) {
        throw new Error('GitLab returned an unexpected assignee set');
      }
      return {};
    },

    async reconcileIssueAssignees(providerTarget: NumberedTarget, assignees: string[]): Promise<Outcome> {
      const { projectId, number } = providerTarget;
      const project = (await showProject(projectId)).project;
      const issue = requireIssue(await client.Issues.show(number, { projectId }), project);
      const current = (issue.assignees ?? []).flatMap((user) => (user ? [user.id] : []));
      const wanted = assignees.map(String);
      if (current.length !== wanted.length || !current.every((id) => wanted.includes(id))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async setChangeRequestBase(payload: {
      base: string; providerTarget: NumberedTarget;
      targetProject: SourceControlProjectRef; expectedTarget: SourceControlMutationTarget;
    }) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequests.edit(projectId, number, { targetBranch: payload.base });
      const { base: _base, ...expected } = payload.expectedTarget;
      const request = requireMutationResponse(raw, payload.targetProject, payload.providerTarget, expected);
      if (request.base !== payload.base) throw new Error('GitLab returned an unexpected merge request base');
      return {};
    },

    async reconcileChangeRequestBase(providerTarget: NumberedTarget, base: string): Promise<Outcome> {
      const { projectId, number } = providerTarget;
      const project = (await showProject(projectId)).project;
      const request = requireMutationMergeRequest(await client.MergeRequests.show(projectId, number), project);
      return request.base === base ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async rebaseChangeRequest({ providerTarget }: { providerTarget: NumberedTarget }) {
      const raw = await client.MergeRequests.rebase(providerTarget.projectId, providerTarget.number);
      if (!fieldsOf(raw)) throw new Error('GitLab returned an invalid rebase answer');
      return {};
    },

    async reconcileRebaseMutation(providerTarget: NumberedTarget, expectedHeadSha: string | undefined): Promise<Outcome> {
      const raw = await client.MergeRequests.show(providerTarget.projectId, providerTarget.number);
      const project = (await showProject(providerTarget.projectId)).project;
      const request = requireMutationMergeRequest(raw, project);
      if (fieldsOf(raw)?.rebase_in_progress === true) return { state: 'outcome-unknown' };
      return isString(expectedHeadSha) && request.headSha !== expectedHeadSha
        ? { state: 'succeeded', result: {} }
        : { state: 'outcome-unknown' };
    },
  };
};
