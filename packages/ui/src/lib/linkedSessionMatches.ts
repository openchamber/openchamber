import type { Session } from '@opencode-ai/sdk/v2';
import type { ForgeProviderKind, ForgeRepoRef } from '@/lib/forge/types';
import {
  buildLinkedIssueId,
  getLinkedIssues,
  parseLinkedIssueRef,
  type LinkedIssue,
} from '@/lib/linkedIssues';

/**
 * Which sessions in a project are "working on" a forge entity, derived
 * client-side from the already-loaded session list.
 *
 * The matching key is the stored `metadata.openchamber.linked_issues` entry id
 * (`owner/repo#number`, or `namespace/repo#number` for gitlab). A session
 * matches when one of its entries has the entity's id AND the entry's provider
 * (recorded, or derived from its url via `parseLinkedIssueRef`) is the
 * provider of the entity being viewed. When no provider can be derived the id
 * match alone is trusted — a link recorded against an unrecognized host is
 * still this entity.
 *
 * Pure and side-effect free apart from reading session metadata — unit-testable
 * without a store.
 */

export type LinkedSessionRow = {
  sessionId: string;
  title: string;
  /** Epoch ms the entity was last linked in this session. */
  linkedAt?: number;
};

/**
 * Loose session shape from the store's session list. `getLinkedIssues` only
 * reads `metadata`, so this is enough to run the match.
 */
export type LinkedSessionCandidate = {
  id: string;
  title?: string | null;
  metadata?: unknown;
};

/**
 * The stored LinkedIssue ids this entity can be recorded under.
 *
 * GitHub and Gitea are flat `owner/repo`. GitLab records the full project path,
 * so a multi-segment namespace (`group/sub/proj`) adds its own candidate
 * (`group/sub/proj#number`) alongside the flat `owner/repo#number` form in case
 * the stored snapshot was written from the flat form.
 */
export const linkedEntityCandidateIds = (repo: ForgeRepoRef, number: number): string[] => {
  const candidates = [buildLinkedIssueId(repo.owner, repo.repo, number)];
  if (repo.namespace && repo.namespace !== repo.owner) {
    candidates.push(buildLinkedIssueId(repo.namespace, repo.repo, number));
  }
  return candidates;
};

const entryProviderKind = (entry: LinkedIssue): ForgeProviderKind | null => {
  if (entry.provider === 'github' || entry.provider === 'gitlab' || entry.provider === 'gitea') {
    return entry.provider;
  }
  return parseLinkedIssueRef(entry)?.provider ?? null;
};

/**
 * Sessions whose stored linked_issues contain this entity.
 *
 * Provider is matched when it can be known (recorded field or derived from the
 * entry url/shape); an entry whose provider cannot be derived matches by id
 * alone. Results are deduped by session id (a session can hold both the flat
 * and the namespaced candidate for the same entity) and sorted by most recent
 * `linkedAt` first, then title.
 */
export const findLinkedSessionsForEntity = (
  sessions: LinkedSessionCandidate[],
  providerKind: ForgeProviderKind,
  candidateIds: string[],
): LinkedSessionRow[] => {
  const candidateSet = new Set(candidateIds);
  const rowsBySessionId = new Map<string, LinkedSessionRow>();

  for (const session of sessions) {
    if (!session.id) continue;
    const entries = getLinkedIssues(session as Session);
    let linkedAt: number | undefined;
    for (const entry of entries) {
      if (!candidateSet.has(entry.id)) continue;
      const provider = entryProviderKind(entry);
      if (provider !== null && provider !== providerKind) continue;
      linkedAt = linkedAt === undefined ? entry.linkedAt : Math.max(linkedAt, entry.linkedAt);
    }
    if (linkedAt === undefined) continue;
    rowsBySessionId.set(session.id, {
      sessionId: session.id,
      title: session.title ?? '',
      linkedAt,
    });
  }

  return Array.from(rowsBySessionId.values()).sort((a, b) => {
    const byLinkedAt = (b.linkedAt ?? 0) - (a.linkedAt ?? 0);
    if (byLinkedAt !== 0) return byLinkedAt;
    return a.title.localeCompare(b.title);
  });
};
