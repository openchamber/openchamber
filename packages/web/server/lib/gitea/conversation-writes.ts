import { isPlainObject } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGiteaClient } from './client.js';
import { instanceCapabilities } from './capabilities.js';
import { withIssueReferences } from './references.js';

type Client = Pick<ReturnType<typeof createGiteaClient>, 'get' | 'put' | 'delete'>;
type Repo = { owner: string; name: string };
type ExistingTarget = Repo & { repoId: number; number: number };
type Outcome = { state: string; result?: object };
type ConversationFlags = { writeAccess?: boolean; locked?: boolean; viewerSubscribed?: boolean };

const fieldsOf = (value: JsonValue | undefined): JsonObject | null => (isPlainObject(value) ? value : null);

const giteaWriteAccess = (raw: JsonObject) => {
  const push = fieldsOf(raw.permissions)?.push;
  return push === true || push === false ? push : undefined;
};

const giteaLockFlag = (itemRaw: JsonValue | undefined) => {
  const locked = fieldsOf(itemRaw)?.is_locked ?? fieldsOf(itemRaw)?.locked;
  return locked === true || locked === false ? locked : undefined;
};

export const withGiteaConversationFlags = <Value>(value: Value, repoRaw: JsonObject, itemRaw: JsonValue | undefined): Value & ConversationFlags => {
  const flags: ConversationFlags = {};
  const writeAccess = giteaWriteAccess(repoRaw);
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

interface ConversationWriteDeps {
  client: Client;
  origin: string;
  provider: string;
  targetRepo(repo: ExistingTarget): Repo;
  repoPath(repo: Repo): string;
  readCurrentLogin(): Promise<string>;
}

export const readGiteaIssueConversation = async <Issue extends { number: number }>(
  client: ReturnType<typeof createGiteaClient>, repoPath: (repo: Repo) => string, issue: Issue, project: Repo, includeReferences: boolean,
) => {
  const [subscribed, withRefs] = await Promise.all([
    readGiteaSubscription(client, repoPath, project, issue.number),
    includeReferences ? withIssueReferences(client, repoPath(project), issue, issue.number) : issue,
  ]);
  return subscribed === null ? withRefs : { ...withRefs, viewerSubscribed: subscribed };
};

export const giteaConversationWrites = ({ client, origin, provider, targetRepo, repoPath, readCurrentLogin }: ConversationWriteDeps) => ({
  repoCapabilities: instanceCapabilities(client, origin, provider),

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
});
