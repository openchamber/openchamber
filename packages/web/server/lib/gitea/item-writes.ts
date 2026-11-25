import { isPlainObject, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGiteaClient } from './client.js';
import type { GiteaProject } from './mappers.js';

type Client = Pick<ReturnType<typeof createGiteaClient>, 'get' | 'patch'>;
type Repo = Pick<GiteaProject, 'owner' | 'name'>;
type ProviderRepo = Repo & { repoId: number };
type ExistingTarget = ProviderRepo & { number: number };
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
}

export const giteaItemWrites = (deps: ItemWriteDeps) => {
  const { client, targetRepo, repoPath, providerLabel, requireIssue, projectOfTarget, malformed, repoUsers } = deps;

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
  };
};
