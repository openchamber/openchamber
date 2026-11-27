import { createHash } from 'node:crypto';
import type { CredentialEntry } from '@opencode/client';
import { readStoredOpenCodeCredentials } from '../opencode/auth.js';
import { mapLimited } from '../shared/map-limited.js';
import { asNonEmptyString } from './utils/index.js';
import type { ProviderUsage } from './utils/contracts.js';
import { readCodexAccountUsage } from './providers/codex.js';
import { readClaudeAccountUsage } from './providers/claude/index.js';

const builtInIntegrationAliases = new Map([
  ['claude', ['anthropic', 'claude-agent', 'claude-code']],
  ['codex', ['openai', 'chatgpt']],
  ['cline-pass', []],
  ['cursor', []],
  ['deepinfra', ['deep-infra', 'deep_infra']],
  ['deepseek', []],
  ['exe-dev', []],
  ['github-copilot', ['copilot']],
  ['hyper', []],
  ['kilo', ['kilocode', 'kilo-code']],
  ['kimi-for-coding', ['kimi-code-plan-cn', 'kimi', 'kimi-code-plan-global']],
  ['minimax-cn-coding-plan', []],
  ['minimax-coding-plan', []],
  ['mistral', []],
  ['nano-gpt', ['nanogpt', 'nano_gpt']],
  ['neuralwatt', []],
  ['ollama-cloud', ['ollamacloud']],
  ['opencode', []],
  ['opencode-go', ['opencode']],
  ['openrouter', []],
  ['wafer', ['wafer-ai', 'wafer_ai', 'wafer.ai']],
  ['xai', []],
  ['zai-coding-plan', ['zai', 'z.ai']],
  ['zenmux', []],
  ['zhipuai-coding-plan', ['zhipuai', 'zhipu']],
]);

type Reading = { fetchedAt: number; usage: ProviderUsage; planLabel: string | null };
type AccountState =
  | { status: 'fresh' | 'expired' | 'missing' | 'unsupported' | 'transient'; reading: Reading | null }
  | { status: 'cooldown'; reading: Reading | null; retryAt?: number };
type AccountUsage = AccountState & { providerId: string; id: string; integrationId: string; label: string };
type AccountReader = (credential: { accessToken: string; accountId: string | null }, deadline: AbortSignal) => Promise<
  { status: 'fresh'; usage: ProviderUsage; planLabel: string | null }
  | { status: 'expired' | 'unsupported' | 'transient' }
  | { status: 'cooldown'; retryAt: number | undefined; fallbackMs?: number }
>;

const FRESH_MS = 3 * 60 * 1000;
const RETRY_MS = 15 * 1000;
const BATCH_DEADLINE_MS = 25_000;
const MAX_READINGS = 256;
const readings = new Map<string, { state: AccountState; validUntil: number }>();
const pending = new Map<string, Promise<AccountState>>();

const readAccount = (
  key: string,
  read: AccountReader,
  credential: { accessToken: string; accountId: string | null },
  expires: number,
  refresh: boolean,
  deadline: AbortSignal,
): Promise<AccountState> | AccountState => {
  const cached = readings.get(key);
  const reading = cached?.state.reading ?? null;
  if (expires > 0 && expires <= Date.now()) return { status: 'expired', reading };
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (cached && Date.now() < cached.validUntil &&
    (!refresh || cached.state.status === 'cooldown')) return cached.state;
  if (deadline.aborted) return { status: 'transient', reading };

  const promise = read(credential, deadline).catch(() => ({ status: 'transient' as const })).then((result): AccountState => {
    const now = Date.now();
    const state: AccountState = result.status === 'fresh'
      ? { status: result.status, reading: { fetchedAt: now, usage: result.usage, planLabel: result.planLabel } }
      : result.status === 'cooldown' && result.retryAt !== undefined && result.retryAt > now
        ? { status: result.status, reading, retryAt: result.retryAt }
        : { status: result.status, reading };
    const validUntil = result.status === 'fresh' ? now + FRESH_MS
      : result.status === 'cooldown' ? result.retryAt ?? now + (result.fallbackMs ?? RETRY_MS)
        : now + RETRY_MS;
    readings.delete(key);
    readings.set(key, { state, validUntil });
    if (readings.size > MAX_READINGS) {
      const oldest = readings.keys().next();
      if (!oldest.done) readings.delete(oldest.value);
    }
    return state;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
};

const readStoredAccount = async (providerId: string, entry: CredentialEntry, refresh: boolean, deadline: AbortSignal): Promise<AccountUsage> => {
  const account = { providerId, id: entry.id, integrationId: entry.integrationID, label: entry.label };
  const { value } = entry;
  if (value.type !== 'oauth') return { ...account, status: 'unsupported', reading: null };

  const reader = providerId === 'codex' && ['chatgpt-browser', 'chatgpt-headless'].includes(value.methodID)
    ? readCodexAccountUsage
    : providerId === 'claude' && ['anthropic', 'claude'].includes(entry.integrationID) && value.methodID === 'oauth'
      ? readClaudeAccountUsage
      : null;
  if (!reader) return { ...account, status: 'unsupported', reading: null };
  const accessToken = asNonEmptyString(value.access);
  if (!accessToken) return { ...account, status: 'missing', reading: null };
  const accountId = providerId === 'codex' ? asNonEmptyString(value.metadata?.accountID) : null;
  const identity = createHash('sha256').update(accessToken).digest('hex');
  const key = JSON.stringify([providerId, entry.integrationID, entry.id, value.methodID, accountId, identity]);
  return { ...account, ...await readAccount(key, reader, { accessToken, accountId }, value.expires, refresh, deadline) };
};

export async function listAccountUsage(providers: readonly string[], refresh: boolean) {
  const selected = new Set(providers);
  const entries = await readStoredOpenCodeCredentials();
  const deadline = AbortSignal.timeout(BATCH_DEADLINE_MS);
  const targets = [...builtInIntegrationAliases].flatMap(([providerId, aliases]) =>
    selected.has(providerId) ? entries.flatMap((entry) =>
      entry.integrationID === providerId || aliases.includes(entry.integrationID) ? [{ providerId, entry }] : []) : [],
  );
  return (await mapLimited(targets, 4, (target) => target
    ? readStoredAccount(target.providerId, target.entry, refresh, deadline)
    : null)).filter((account) => account !== null);
}
