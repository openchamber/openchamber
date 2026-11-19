
import { providerGrantOf, type SpaceEntry, type SpaceJournalRecord } from './spaces-api';

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export const isDomainName = (value: string): boolean => DOMAIN_PATTERN.test(value);

type ProviderAccess = 'granted' | 'needs_again' | 'none';

export const providerAccessOf = (entry: SpaceEntry, providerId: string): ProviderAccess => {
  const grant = providerGrantOf(entry.grants, providerId);
  if (!grant) return 'none';
  return entry.needsAccess.includes(grant.id) ? 'needs_again' : 'granted';
};

type SpaceAccessNotice =
  | { kind: 'needs_again'; providers: string[] }
  | { kind: 'no_model' }
  | { kind: 'unknown' };

export const spaceAccessNoticeOf = (entry: SpaceEntry | undefined): SpaceAccessNotice | null => {
  if (!entry || entry.state !== 'running') return null;
  if (entry.access === 'unknown') return { kind: 'unknown' };
  const models = entry.grants.filter((grant) => grant.kind === 'model' || grant.kind === 'login' || grant.kind === 'custom');
  // external: https://opencode.ai/docs/zen/#endpoints Free-tier models reject requests from isolated spaces even with open internet.
  if (models.length === 0) return { kind: 'no_model' };
  const providers = models.filter((grant) => entry.needsAccess.includes(grant.id)).map((grant) => grant.provider);
  return providers.length > 0 ? { kind: 'needs_again', providers } : null;
};

export type BlockReason = 'not_on_list' | 'private_address' | 'unresolved' | 'address_not_name' | 'port' | 'always_refused' | 'too_many' | 'other';

const reasonOf = (decision: string): BlockReason | null => {
  if (!decision.startsWith('deny:')) return null;
  const reason = decision.slice('deny:'.length);
  if (reason === 'not-on-allowlist') return 'not_on_list';
  if (reason === 'blocked-address') return 'private_address';
  if (reason.startsWith('unresolved')) return 'unresolved';
  if (reason === 'not-a-name') return 'address_not_name';
  if (reason === 'port') return 'port';
  if (reason === 'always-refused') return 'always_refused';
  if (reason === 'too-many-tunnels' || reason === 'too-many-connections') return 'too_many';
  return 'other';
};

type BlockedAttempt = { host: string; port: number; reason: BlockReason; count: number; last: string };

export const blockedAttemptsOf = (records: readonly SpaceJournalRecord[]): BlockedAttempt[] => {
  const byKey = new Map<string, BlockedAttempt>();
  for (const record of records) {
    const reason = reasonOf(record.decision);
    if (!reason) continue;
    const key = `${reason}\u0000${record.host}\u0000${reason === 'port' ? record.port : ''}`;
    const known = byKey.get(key);
    if (known) {
      known.count += 1;
      if (record.at > known.last) known.last = record.at;
    } else {
      byKey.set(key, { host: record.host, port: record.port, reason, count: 1, last: record.at });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
};

const CLOCK_SLACK_MS = 2_000;

export const setupBlockedDomainsOf = (records: readonly SpaceJournalRecord[], span: { startedAt: string | null; finishedAt: string | null }): string[] => {
  if (span.startedAt === null || span.finishedAt === null) return [];
  const from = Date.parse(span.startedAt) - CLOCK_SLACK_MS;
  const to = Date.parse(span.finishedAt) + CLOCK_SLACK_MS;
  const domains: string[] = [];
  for (const record of [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(record.at);
    if (!(at >= from && at <= to)) continue;
    if (reasonOf(record.decision) !== 'not_on_list' || !isDomainName(record.host) || domains.includes(record.host)) continue;
    domains.push(record.host);
  }
  return domains;
};
