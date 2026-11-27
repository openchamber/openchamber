import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGiteaClient } from './client.js';
import type { GiteaProject } from './mappers.js';

type Client = Pick<ReturnType<typeof createGiteaClient>, 'get' | 'patch' | 'post'>;
type Repo = Pick<GiteaProject, 'owner' | 'name'>;
type ProviderRepo = Repo & { repoId: number };
type ExistingTarget = ProviderRepo & { number: number };
type Coordinates = { number?: number | undefined; head?: string | undefined; base?: string | undefined; headSha?: string | undefined };
type Outcome = { state: string; result?: object };
const fieldsOf = (value: JsonValue | undefined): JsonObject | null => (isPlainObject(value) ? value : null);

interface ItemWriteDeps {
  client: Client;
  targetRepo(repo: ProviderRepo): Repo;
  repoPath(repo: Repo): string;
  providerLabel: string;
  requireIssue(raw: JsonValue | undefined, project: GiteaProject): { number: number; assignees?: Array<{ username: string }> };
  projectOfTarget(target: ProviderRepo): GiteaProject;
  malformed(message: string): Error;
  repoUsers(repo: Repo, kind?: 'collaborators' | 'assignees'): Promise<JsonValue[]>;
  requirePull(raw: JsonValue | undefined, project: GiteaProject): { number: number; base: string; headSha?: string };
  requireExpected(expected: Coordinates, actual: Coordinates, options?: { beforeWrite?: boolean }): void;
  readTargetPull(target: ExistingTarget): Promise<JsonObject>;
}

type BranchFlags = { branchWriteAccess?: boolean };

// external: https://docs.gitea.com/api/1.21/#tag/repository/operation/repoGet `permissions.push` is the viewer's right to write the repository's branches.
export const giteaBranchFlags = (repo: JsonObject): BranchFlags => {
  const push = fieldsOf(repo.permissions)?.push;
  return isBoolean(push) ? { branchWriteAccess: push } : {};
};

export const giteaItemWrites = (deps: ItemWriteDeps) => {
  const { client, targetRepo, repoPath, providerLabel, requireIssue, projectOfTarget, malformed, repoUsers, requirePull, requireExpected, readTargetPull } = deps;

  const assigneeLogins = async (providerTarget: ExistingTarget, assignees: string[]) => {
    if (assignees.length === 0) return [];
    const repo = targetRepo(providerTarget);
    const raw = fieldsOf(await client.get(`${repoPath(repo)}/issues/${providerTarget.number}`));
    const own = Array.isArray(raw?.assignees) ? raw.assignees : [];
    const byId = new Map<string, string>();
    const learn = (users: JsonValue[]) => users.forEach((user) => {
      const fields = fieldsOf(user);
      if (fields && Number.isInteger(fields.id) && isString(fields.login)) byId.set(String(fields.id), fields.login);
    });
    learn(own);
    if (assignees.some((entry) => /^\d+$/.test(entry) && !byId.has(entry))) learn(await repoUsers(repo, 'assignees'));
    return assignees.map((entry) => {
      const login = byId.get(entry) ?? (/^\d+$/.test(entry) ? null : entry);
      if (!login) throw Object.assign(new Error(`${providerLabel} user ${entry} cannot be assigned in this repository`), { status: 422 });
      return login;
    });
  };

  return {
    async setIssueAssignees({ providerTarget, assignees }: { providerTarget: ExistingTarget; assignees: string[] }) {
      const logins = await assigneeLogins(providerTarget, assignees);
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`, { assignees: logins });
      const issue = requireIssue(raw, projectOfTarget(providerTarget));
      if (issue.number !== providerTarget.number) throw malformed(`${providerLabel} answered an issue outside the resolved mutation target`);
      const answered = (issue.assignees ?? []).map((user) => user.username);
      if (answered.length !== logins.length || !answered.every((login) => logins.includes(login))) {
        throw malformed(`${providerLabel} answered an unexpected assignee set`);
      }
      return {};
    },

    async reconcileIssueAssignees(providerTarget: ExistingTarget, assignees: string[]): Promise<Outcome> {
      const logins = await assigneeLogins(providerTarget, assignees);
      const issue = requireIssue(await client.get(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`), projectOfTarget(providerTarget));
      const current = (issue.assignees ?? []).map((user) => user.username);
      if (current.length !== logins.length || !current.every((login) => logins.includes(login))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async setChangeRequestBase({ providerTarget, base, expectedTarget }: {
      providerTarget: ExistingTarget; base: string; expectedTarget: Coordinates;
    }) {
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, { base });
      const request = requirePull(raw, projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number }, request);
      if (request.base !== base) throw new Error('Gitea returned an unexpected pull request base');
      return {};
    },

    async reconcileChangeRequestBase(providerTarget: ExistingTarget, base: string): Promise<Outcome> {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      return current.base === base ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    // external: https://docs.gitea.com/api/1.21/#tag/repository/operation/repoUpdatePullRequest Gitea's update takes no head SHA
    async updateChangeRequestBranch({ providerTarget, expectedHeadSha, expectedTarget }: {
      providerTarget: ExistingTarget; expectedHeadSha: string; expectedTarget: Coordinates;
    }) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number, headSha: expectedHeadSha }, current, { beforeWrite: true });
      await client.post(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/update?style=merge`);
      return {};
    },

    async reconcileChangeRequestBranch(providerTarget: ExistingTarget, _expectedHeadSha: string): Promise<Outcome> {
      await readTargetPull(providerTarget);
      return { state: 'outcome-unknown' };
    },
  };
};
