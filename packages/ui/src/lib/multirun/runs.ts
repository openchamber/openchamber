import type { Session } from '@/lib/opencode/model';
import { getMultiRunIdentity, type MultiRunIdentity } from './identity';

/** One member session of a run: a lane (`run`) or a fused result (`fusion`). */
export type MultiRunMember = {
  sessionId: string;
  identity: MultiRunIdentity;
};

/** A multi-run as the sidebar, overview and tabs see it, derived from session metadata. */
export type MultiRunSummary = {
  key: string;
  title: string;
  groupSlug: string;
  /** Lanes in variant order, then creation order. */
  lanes: readonly MultiRunMember[];
  /** Fused results, newest first. */
  fusions: readonly MultiRunMember[];
  /** Fusions first, then lanes: the order rows and cards render in. */
  memberIds: readonly string[];
  /** Distinct lane providers in lane order, for the stacked logos. */
  providerIDs: readonly string[];
  /** Distinct prompt variants (`runGroup`) in order; `undefined` is the single-prompt variant. */
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

// Session records are replaced on every update, so the object is a complete
// cache key: an unchanged session is never parsed twice. The legacy scope is
// part of the key because a title-only identity depends on it.
const identityCache = new WeakMap<Session, { scope: string | null; identity: MultiRunIdentity | null }>();

export const readMultiRunIdentity = (session: Session, scope: string | null): MultiRunIdentity | null => {
  const cached = identityCache.get(session);
  if (cached && cached.scope === scope) return cached.identity;
  const identity = getMultiRunIdentity(session, scope ?? session.directory);
  identityCache.set(session, { scope, identity });
  return identity;
};

const variantRank = (runGroup: string | undefined): number => (runGroup ? Number(runGroup.slice(1)) : 0);

/** `g1` → `A`, `g2` → `B`; a single-prompt run is `A`. */
export const multiRunVariantLabel = (runGroup: string | undefined): string => {
  const rank = Math.max(1, variantRank(runGroup));
  return rank <= 26 ? String.fromCharCode(64 + rank) : String(rank);
};

/**
 * Groups active root sessions into runs. A run needs at least two active
 * members: after "Keep" leaves a single survivor, it is an ordinary session
 * again. Archived sessions never form or join a run.
 */
export function buildMultiRunIndex(
  sessions: Iterable<Session>,
  resolveLegacyScope: (session: Session) => string | null,
): MultiRunIndex {
  const members = new Map<string, Array<{ session: Session; identity: MultiRunIdentity }>>();
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id) || session.time?.archived || session.parentID) continue;
    seen.add(session.id);
    const identity = readMultiRunIdentity(session, resolveLegacyScope(session));
    if (!identity) continue;
    const list = members.get(identity.key);
    if (list) list.push({ session, identity });
    else members.set(identity.key, [{ session, identity }]);
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
