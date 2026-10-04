import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type {
  GitHubIssueLiveSummary,
  GitHubPullRequestLiveSummary,
  GitHubPullRequestRef,
  SourceControlAPI,
} from '@/lib/api/types';
import type { GitLabThreadRef } from '@/lib/linkedIssues';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getLinkedChangeRequestVisualSummary, type PrVisualSummary } from '@/stores/useGitHubPrStatusStore';

/** The server answers at most this many merge requests and issues per request. */
const MAX_REFS_PER_REQUEST = 50;

const keyOf = (runtimeKey: string, ref: GitLabThreadRef): string => `${runtimeKey}|${ref.key}`;
const toRequestRef = (ref: GitLabThreadRef): GitHubPullRequestRef => ({ owner: ref.owner, repo: ref.repo, number: ref.number });
const answerKey = (ref: GitHubPullRequestRef): string => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

type GitLabLinkedStateStore = {
  /** Live state of linked merge requests, by runtime and thread. Runtime-only. */
  mergeRequests: Record<string, GitHubPullRequestLiveSummary>;
  /** Live state of linked issues, by runtime and thread. Runtime-only. */
  issues: Record<string, GitHubIssueLiveSummary>;
  /**
   * Asks each instance about the threads not asked within `minAgeMs`. A
   * merged merge request is final and not asked again. An item GitLab does
   * not answer keeps no state; a failed request keeps the last known one and
   * waits for the next cadence.
   */
  sync: (refs: readonly GitLabThreadRef[], sourceControl: Pick<SourceControlAPI, 'gitlabSummaries'>, minAgeMs: number) => Promise<void>;
  resetForRuntimeSwitch: () => void;
};

const lastAskedAt = new Map<string, number>();
let inFlight = false;
// Asked while a request ran (the sidebar and the Linked section ask at once);
// sent right after it rather than a whole cadence later.
let queued: { refs: Map<string, GitLabThreadRef>; sourceControl: Pick<SourceControlAPI, 'gitlabSummaries'>; minAgeMs: number } | null = null;
let generation = 0;

export const useGitLabLinkedStateStore = create<GitLabLinkedStateStore>((set, get) => ({
  mergeRequests: {},
  issues: {},
  sync: async (refs, sourceControl, minAgeMs) => {
    if (inFlight) {
      const pending = queued?.refs ?? new Map<string, GitLabThreadRef>();
      for (const ref of refs) pending.set(ref.key, ref);
      queued = { refs: pending, sourceControl, minAgeMs: Math.min(queued?.minAgeMs ?? minAgeMs, minAgeMs) };
      return;
    }
    const runtimeKey = getRuntimeKey();
    const now = Date.now();
    const { mergeRequests } = get();
    const due = new Map<string, GitLabThreadRef>();
    for (const ref of refs) {
      const key = keyOf(runtimeKey, ref);
      if (due.has(ref.key) || now - (lastAskedAt.get(key) ?? 0) < minAgeMs) continue;
      if (ref.thread === 'pull' && mergeRequests[key]?.state === 'merged') continue;
      due.set(ref.key, ref);
    }
    if (due.size === 0) return;

    const byInstance = new Map<string, GitLabThreadRef[]>();
    for (const ref of due.values()) {
      lastAskedAt.set(keyOf(runtimeKey, ref), now);
      byInstance.set(ref.instance, [...(byInstance.get(ref.instance) ?? []), ref]);
    }
    inFlight = true;
    const requestGeneration = generation;
    try {
      for (const [instance, instanceRefs] of byInstance) {
        for (let start = 0; start < instanceRefs.length; start += MAX_REFS_PER_REQUEST) {
          const batch = instanceRefs.slice(start, start + MAX_REFS_PER_REQUEST);
          const pulls = batch.filter((ref) => ref.thread === 'pull');
          const issues = batch.filter((ref) => ref.thread === 'issue');
          let result: Awaited<ReturnType<SourceControlAPI['gitlabSummaries']>>;
          try {
            result = await sourceControl.gitlabSummaries(instance, pulls.map(toRequestRef), issues.map(toRequestRef));
          } catch (error) {
            // One instance failing leaves the others to answer.
            console.warn('[gitlab] could not refresh linked merge request and issue states', error);
            continue;
          }
          if (requestGeneration !== generation) return;
          if (!result.connected) continue;
          const answeredPulls = new Map(result.summaries.map((summary) => [answerKey(summary), summary]));
          const answeredIssues = new Map(result.issueSummaries.map((summary) => [answerKey(summary), summary]));
          set((state) => {
            const nextMergeRequests = { ...state.mergeRequests };
            const nextIssues = { ...state.issues };
            for (const ref of pulls) {
              const summary = answeredPulls.get(answerKey(toRequestRef(ref)));
              if (summary) nextMergeRequests[keyOf(runtimeKey, ref)] = summary;
              else delete nextMergeRequests[keyOf(runtimeKey, ref)];
            }
            for (const ref of issues) {
              const summary = answeredIssues.get(answerKey(toRequestRef(ref)));
              if (summary) nextIssues[keyOf(runtimeKey, ref)] = summary;
              else delete nextIssues[keyOf(runtimeKey, ref)];
            }
            return { mergeRequests: nextMergeRequests, issues: nextIssues };
          });
        }
      }
    } finally {
      inFlight = false;
      const next = queued;
      queued = null;
      if (next && requestGeneration === generation) void get().sync([...next.refs.values()], next.sourceControl, next.minAgeMs);
    }
  },
  resetForRuntimeSwitch: () => {
    generation += 1;
    queued = null;
    lastAskedAt.clear();
    set({ mergeRequests: {}, issues: {} });
  },
}));

/** Live state of each linked GitLab issue, in order; null until known. */
export const useGitLabIssueStates = (refs: readonly GitLabThreadRef[]): Array<GitHubIssueLiveSummary | null> => {
  const runtimeKey = getRuntimeKey();
  return useGitLabLinkedStateStore(useShallow((state) => refs.map((ref) => state.issues[keyOf(runtimeKey, ref)] ?? null)));
};

/**
 * Badges of the linked GitLab merge requests, in order; null for one whose
 * state has not arrived yet.
 */
export const useGitLabMergeRequestVisualSummaries = (
  links: ReadonlyArray<{ ref: GitLabThreadRef; url: string; title: string }>,
): Array<PrVisualSummary | null> => {
  const runtimeKey = getRuntimeKey();
  return useGitLabLinkedStateStore(useShallow((state) => links.map(({ ref, url, title }) => {
    const key = keyOf(runtimeKey, ref);
    const summary = state.mergeRequests[key];
    return summary
      ? getLinkedChangeRequestVisualSummary(key, { owner: ref.owner, repo: ref.repo, number: ref.number, url, title }, summary, { provider: 'gitlab', instance: ref.instance })
      : null;
  })));
};
