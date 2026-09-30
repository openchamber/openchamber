// What a space's model access and network look like to the user, read from the journey list the
// host answers with the gatekeeper's own view: which provider has a key, which needs it again after
// a restart, and what a blocked attempt in the gatekeeper's journal was refused for.

import type { SpaceEntry, SpaceJournalRecord } from './spaces-api';

// The allowlist's rule for a name, the server's own (`space-records.js`): labels of letters,
// digits and hyphens, with a real last label.
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Whether a lower-case value is a name the allowlist takes. */
export const isDomainName = (value: string): boolean => DOMAIN_PATTERN.test(value);

type ProviderAccess = 'granted' | 'needs_again' | 'none';

/** Whether the space holds a key for a provider now, per the gatekeeper, or needs it again. */
export const providerAccessOf = (entry: SpaceEntry, providerId: string): ProviderAccess => {
  const grant = entry.grants.find((candidate) => candidate.kind === 'model' && candidate.provider === providerId);
  if (!grant) return 'none';
  return entry.needsAccess.includes(grant.id) ? 'needs_again' : 'granted';
};

/**
 * What the group and the header warn about for a running space: keys the gatekeeper lost at a
 * restart, no model key at all, or a gatekeeper that could not be asked. Nothing for a space that
 * is not running: there is no gatekeeper to ask.
 */
type SpaceAccessNotice =
  | { kind: 'needs_again'; providers: string[] }
  | { kind: 'no_model' }
  | { kind: 'unknown' };

export const spaceAccessNoticeOf = (entry: SpaceEntry | undefined): SpaceAccessNotice | null => {
  if (!entry || entry.state !== 'running') return null;
  if (entry.access === 'unknown') return { kind: 'unknown' };
  const models = entry.grants.filter((grant) => grant.kind === 'model');
  if (models.length === 0) return { kind: 'no_model' };
  const providers = models.filter((grant) => entry.needsAccess.includes(grant.id)).map((grant) => grant.provider);
  return providers.length > 0 ? { kind: 'needs_again', providers } : null;
};

/** Why the gatekeeper refused, in the words the dialog uses; only `not_on_list` can be opened. */
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

/**
 * The refused attempts of a journal, one per destination and reason, the latest first. What was
 * allowed, and what was allowed and could not be reached, is left out: the dialog is about what
 * the user can open. `host` is what the agent asked for, shown as it is.
 */
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

// The gatekeeper stamps its journal with the clock of its container, the host stamps the setup run
// with its own; this much apart still counts as the same moment.
const CLOCK_SLACK_MS = 2_000;

/**
 * The domains a failed setup run could not reach: those the journal shows refused as not on the
 * list between the run's start and its failure, each once, in the order first tried. The journal
 * does not say which process asked, so an attempt of the agent's within the span is listed too.
 * Nothing when the run's span is unknown, from a host before it was kept.
 */
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
