import type { Session } from '@/lib/opencode/model';
import { resolveMultiRunIdentity, type MultiRunIdentity } from './identity';

export type MultiRunMember = {
  sessionId: string;
  identity: MultiRunIdentity;
};

export type MultiRunSummary = {
  key: string;
  title: string;
  groupSlug: string;
  lanes: readonly MultiRunMember[];
  fusions: readonly MultiRunMember[];
  memberIds: readonly string[];
  providerIDs: readonly string[];
  variants: readonly (string | undefined)[];
  createdAt: number;
  lastActivity: number;
  autoFusion?: MultiRunIdentity['autoFusion'];
};

export type MultiRunIndex = {
  runs: ReadonlyMap<string, MultiRunSummary>;
  runKeyBySessionId: ReadonlyMap<string, string>;
};

export const EMPTY_MULTI_RUN_INDEX: MultiRunIndex = Object.freeze({
  runs: new Map(),
  runKeyBySessionId: new Map(),
});

const identityCache = new WeakMap<Session, { scoped: boolean; scope: string | null; identity: MultiRunIdentity | null }>();

export const readMultiRunIdentityWith = (
  session: Session,
  resolveScope: (session: Session) => string | null,
): MultiRunIdentity | null => {
  const cached = identityCache.get(session);
  if (cached && !cached.scoped) return cached.identity;
  if (cached) {
    const scope = resolveScope(session);
    if (cached.scope === scope) return cached.identity;
  }
  let scoped = false;
  let scope: string | null = null;
  const identity = resolveMultiRunIdentity(session, () => {
    scoped = true;
    scope = resolveScope(session);
    return scope ?? session.directory;
  });
  identityCache.set(session, { scoped, scope, identity });
  return identity;
};

export const readMultiRunIdentity = (session: Session, scope: string | null): MultiRunIdentity | null => (
  readMultiRunIdentityWith(session, () => scope)
);

const variantRank = (runGroup: string | undefined): number => (runGroup ? Number(runGroup.slice(1)) : 0);

export const multiRunVariantLabel = (runGroup: string | undefined): string => {
  const rank = Math.max(1, variantRank(runGroup));
  return rank <= 26 ? String.fromCharCode(64 + rank) : String(rank);
};

type IndexedMember = { session: Session; identity: MultiRunIdentity };

let lastIndexed: { members: IndexedMember[]; index: MultiRunIndex } | null = null;

const sameMembers = (left: readonly IndexedMember[], right: readonly IndexedMember[]): boolean => (
  left.length === right.length
  && left.every((member, index) => member.session === right[index].session && member.identity === right[index].identity)
);

export function buildMultiRunIndex(
  sessions: Iterable<Session>,
  resolveLegacyScope: (session: Session) => string | null,
): MultiRunIndex {
  const indexed: IndexedMember[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id) || session.time?.archived || session.parentID) continue;
    seen.add(session.id);
    const identity = readMultiRunIdentityWith(session, resolveLegacyScope);
    if (identity) indexed.push({ session, identity });
  }
  if (lastIndexed && sameMembers(lastIndexed.members, indexed)) return lastIndexed.index;
  const index = indexMembers(indexed);
  lastIndexed = { members: indexed, index };
  return index;
}

function indexMembers(indexed: readonly IndexedMember[]): MultiRunIndex {
  const members = new Map<string, IndexedMember[]>();
  for (const member of indexed) {
    const list = members.get(member.identity.key);
    if (list) list.push(member);
    else members.set(member.identity.key, [member]);
  }

  const runs = new Map<string, MultiRunSummary>();
  const runKeyBySessionId = new Map<string, string>();
  for (const [key, list] of members) {
    if (list.length < 2) continue;
    const lanes = list
      .filter((entry) => entry.identity.role === 'run')
      .sort((a, b) => variantRank(a.identity.runGroup) - variantRank(b.identity.runGroup)
        || a.session.time.created - b.session.time.created || a.session.id.localeCompare(b.session.id));
    const fusions = list
      .filter((entry) => entry.identity.role === 'fusion')
      .sort((a, b) => b.session.time.created - a.session.time.created || a.session.id.localeCompare(b.session.id));
    const ordered = [...fusions, ...lanes];
    const titled = ordered.find((entry) => entry.identity.title);
    const withAutoFusion = lanes.find((entry) => entry.identity.autoFusion);
    runs.set(key, Object.freeze({
      key,
      title: titled?.identity.title ?? list[0].identity.groupSlug,
      groupSlug: list[0].identity.groupSlug,
      lanes: Object.freeze(lanes.map(({ session, identity }) => ({ sessionId: session.id, identity }))),
      fusions: Object.freeze(fusions.map(({ session, identity }) => ({ sessionId: session.id, identity }))),
      memberIds: Object.freeze(ordered.map((entry) => entry.session.id)),
      providerIDs: Object.freeze([...new Set(lanes.map((entry) => entry.identity.providerID))]),
      variants: Object.freeze([...new Set(lanes.map((entry) => entry.identity.runGroup))]),
      createdAt: Math.min(...list.map((entry) => entry.session.time.created)),
      lastActivity: Math.max(...list.map((entry) => entry.session.time.updated ?? entry.session.time.created)),
      autoFusion: withAutoFusion?.identity.autoFusion,
    }));
    for (const entry of list) runKeyBySessionId.set(entry.session.id, key);
  }
  return Object.freeze({ runs, runKeyBySessionId });
}
