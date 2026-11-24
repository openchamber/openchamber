import type { SourceControlProjectRef } from '@openchamber/sdk';
import { isRecord } from '../shared/guards.js';
import type { JsonObject } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';
import type { GitLabMappedIssue } from './mappers.js';

// external: https://docs.gitlab.com/user/permissions/ Planner is the lowest role that sets an issue's assignees.
const PLANNER_ACCESS_LEVEL = 15;

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['Projects']['show']>>;
type NumberedTarget = { projectId: string; number: number };
type Outcome = { state: string; result?: object };

interface ProjectWithRaw { project: SourceControlProjectRef }
interface ItemWriteDeps {
  client: Pick<Client, 'Issues'>;
  showProject(path: string): Promise<ProjectWithRaw>;
  requireIssue<P extends SourceControlProjectRef>(raw: Reply, project: P): GitLabMappedIssue<P>;
}

const fieldsOf = <Value>(value: Value): JsonObject | null => {
  if (!isRecord(value)) return null;
  // SAFETY: provider payloads and client failures are objects; every field read below is re-checked before use.
  return value as JsonObject;
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
  return levels.some((level) => level >= PLANNER_ACCESS_LEVEL);
};

type ItemFlags = { writeAccess?: boolean };

export const gitlabItemFlags = <Value, ProjectRaw>(value: Value, projectRaw: ProjectRaw): Value & ItemFlags => {
  const flags: ItemFlags = {};
  const writeAccess = gitlabWriteAccess(projectRaw);
  if (writeAccess !== undefined) flags.writeAccess = writeAccess;
  return { ...value, ...flags };
};

export const gitlabItemWrites = (deps: ItemWriteDeps) => {
  const { client, showProject, requireIssue } = deps;

  return {
    async setIssueAssignees(payload: {
      assignees: string[]; providerTarget: NumberedTarget; targetProject: SourceControlProjectRef;
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
  };
};
