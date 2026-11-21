import { isPlainObject, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGiteaClient } from './client.js';
import type { GiteaProject } from './mappers.js';

type Client = Pick<ReturnType<typeof createGiteaClient>, 'get' | 'patch' | 'post' | 'put' | 'delete'>;
type Repo = Pick<GiteaProject, 'owner' | 'name'>;
type ProviderRepo = Repo & { repoId: number };
type ExistingTarget = ProviderRepo & { number: number };
type Coordinates = { number?: number | undefined; head?: string | undefined; base?: string | undefined; headSha?: string | undefined };
type Outcome = { state: string; result?: object };
type ItemFlags = { writeAccess?: boolean; locked?: boolean; subscribed?: boolean };

const fieldsOf = (value: JsonValue | undefined): JsonObject | null => (isPlainObject(value) ? value : null);

const giteaWriteAccess = (raw: JsonObject) => {
  const push = fieldsOf(raw.permissions)?.push;
  return push === true || push === false ? push : undefined;
};

const giteaLockFlag = (itemRaw: JsonValue | undefined) => {
  const locked = fieldsOf(itemRaw)?.is_locked ?? fieldsOf(itemRaw)?.locked;
  return locked === true || locked === false ? locked : undefined;
};

export const withGiteaWriteAccess = <Value>(value: Value, raw: JsonObject, itemRaw: JsonValue | undefined): Value & ItemFlags => {
  const flags: ItemFlags = {};
  const writeAccess = giteaWriteAccess(raw);
  if (writeAccess !== undefined) flags.writeAccess = writeAccess;
  const locked = giteaLockFlag(itemRaw);
  if (locked !== undefined) flags.locked = locked;
  return { ...value, ...flags };
};

export const readGiteaSubscription = async (
  client: Pick<Client, 'get'>, repoPath: (repo: Repo) => string, repo: Repo, number: number,
): Promise<boolean | null> => {
  try {
    const answer = await client.get(`${repoPath(repo)}/issues/${number}/subscriptions/check`);
    const subscribed = fieldsOf(answer)?.subscribed;
    return subscribed === true || subscribed === false ? subscribed : null;
  } catch {
    return null;
  }
};

interface ItemWriteDeps {
  client: Client;
  targetRepo(repo: ProviderRepo): Repo;
  repoPath(repo: Repo): string;
  providerLabel: string;
  requireIssue(raw: JsonValue | undefined, project: GiteaProject): { number: number; assignees?: Array<{ username: string }> };
  requirePull(raw: JsonValue | undefined, project: GiteaProject): { number: number; base: string; headSha?: string };
  projectOfTarget(target: ProviderRepo): GiteaProject;
  branchRepoId(value: JsonValue | undefined): number | null;
  malformed(message: string): Error;
  requireExpected(expected: Coordinates, actual: Coordinates): void;
  readTargetPull(target: ExistingTarget): Promise<JsonObject>;
  repoUsers(repo: Repo, kind?: 'collaborators' | 'assignees'): Promise<JsonValue[]>;
  readCurrentLogin(): Promise<string>;
}

export const giteaItemWrites = (deps: ItemWriteDeps) => {
  const { client, targetRepo, repoPath, providerLabel, requireIssue, requirePull, projectOfTarget, branchRepoId, malformed, requireExpected, readTargetPull, repoUsers, readCurrentLogin } = deps;

  const assigneeLogins = async (providerTarget: ExistingTarget, assignees: string[]) => {
    const repo = targetRepo(providerTarget);
    const raw = fieldsOf(await client.get(`${repoPath(repo)}/issues/${providerTarget.number}`));
    const own = Array.isArray(raw?.assignees) ? raw.assignees : [];
    const users = [...own, ...(await repoUsers(repo)), ...(await repoUsers(repo, 'assignees'))].flatMap((user) => {
      const fields = fieldsOf(user);
      return fields && Number.isInteger(fields.id) && isString(fields.login) ? [{ id: Number(fields.id), login: fields.login }] : [];
    });
    const byId = new Map(users.map((user) => [String(user.id), user.login]));
    return assignees.map((entry) => {
      const login = byId.get(entry) ?? (/^\d+$/.test(entry) ? null : entry);
      if (!login) throw Object.assign(new Error(`${providerLabel} user ${entry} cannot be assigned in this repository`), { status: 422 });
      return login;
    });
  };

  return {
    async setSubscription({ providerTarget, subscribed }: { providerTarget: ExistingTarget; subscribed: boolean }) {
      const login = await readCurrentLogin();
      const path = `${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/subscriptions/${encodeURIComponent(login)}`;
      if (subscribed) await client.put(path);
      else await client.delete(path);
      return {};
    },

    async reconcileSubscription(providerTarget: ExistingTarget, subscribed: boolean): Promise<Outcome> {
      const current = await readGiteaSubscription(client, repoPath, targetRepo(providerTarget), providerTarget.number);
      return current !== null && current === subscribed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async setConversationLock({ providerTarget, locked }: { providerTarget: ExistingTarget; locked: boolean; kind?: string }) {
      const path = `${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/lock`;
      if (locked) await client.put(path, { lock: true });
      else await client.delete(path);
      return {};
    },

    async reconcileLockMutation(providerTarget: ExistingTarget, locked: boolean): Promise<Outcome> {
      const issue = fieldsOf(await client.get(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`));
      const current = issue?.is_locked ?? issue?.locked;
      return current === locked ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async setChangeRequestBase({ providerTarget, base, expectedTarget }: {
      providerTarget: ExistingTarget; base: string; expectedTarget: Coordinates;
    }) {
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, { base });
      if (branchRepoId(fieldsOf(raw)?.base) !== providerTarget.repoId) throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
      const request = requirePull(raw, projectOfTarget(providerTarget));
      const { base: _base, ...expected } = expectedTarget;
      requireExpected(expected, request);
      if (request.base !== base) throw malformed(`${providerLabel} returned an unexpected pull request base`);
      return {};
    },

    async reconcileChangeRequestBase(providerTarget: ExistingTarget, base: string): Promise<Outcome> {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      return current.base === base ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async updateChangeRequestBranch({ providerTarget, expectedHeadSha, expectedTarget }: {
      providerTarget: ExistingTarget; expectedHeadSha: string; expectedTarget: Coordinates;
    }) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number, headSha: expectedHeadSha }, current);
      await client.post(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/update?style=merge`);
      return {};
    },

    async reconcileChangeRequestBranch(providerTarget: ExistingTarget, expectedHeadSha: string): Promise<Outcome> {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      return current.headSha !== expectedHeadSha ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

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
