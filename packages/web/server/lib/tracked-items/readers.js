// The provider reads behind tracked items, each answering one batch in the
// service's terms: `ok` with GitHub-shaped summaries, `disconnected` when no
// account on that host can answer, `unavailable` when it should be asked
// again later. Accounts are the ones the app is signed in to now, the way
// linked items have always been read.

/**
 * `readGitLabLiveSummaries({ instance, refs, issueRefs })` comes from the
 * GitLab routes, which own GitLab accounts and their reconciliation.
 */
export function createTrackedItemReaders({
  loadGitHub = () => import('../github/index.js'),
  loadGitHubSummaries = () => import('../github/pr-summaries.js'),
  loadGitHubRateLimit = () => import('../github/rate-limit.js'),
  loadLinear = () => import('../linear/index.js'),
  readGitLabLiveSummaries,
}) {
  return {
    async github({ instance = null, accountId = null, pulls, issues }) {
      const [github, { fetchPrSummaries, isGraphqlRateLimitError }, rateLimit] = await Promise.all([
        loadGitHub(), loadGitHubSummaries(), loadGitHubRateLimit(),
      ]);
      // The item's instance is its host; missing means github.com. Cooldowns are
      // keyed per host, so one enterprise instance's rate limit or 401 is that
      // host's problem only and never pauses github.com (or another instance).
      const host = String(instance ?? '').trim().toLowerCase() || 'github.com';
      if (rateLimit.isGitHubRateLimited(host)) return { status: 'unavailable' };
      // A bound repository is read with its own account: on github.com and on a
      // trusted enterprise host alike, the named account (a per-instance PAT or
      // a gh account) resolves with `getOctokitForAccountId`, which refuses
      // untrusted or nonexistent accounts with null. Only an absent bound
      // account — or one that no longer resolves — falls back to the host's
      // current credential, which is itself null for an untrusted host, so an
      // untrusted host still reads nothing.
      const bound = accountId ? await github.getOctokitForAccountId(accountId) : null;
      const octokit = bound?.octokit ?? await github.getOctokitOrNull(host);
      if (!octokit) return { status: 'disconnected' };
      try {
        const { summaries, issueSummaries } = await fetchPrSummaries({ octokit, refs: pulls, issueRefs: issues });
        return { status: 'ok', pulls: summaries, issues: issueSummaries };
      } catch (error) {
        // A github.com 401 means the stored login is gone; an enterprise 401
        // (its gh token went stale) is that host's alone. Both are that response:
        // the service backs off per host and never touches another host's login.
        if ((error?.status ?? error?.response?.status) === 401) return { status: 'disconnected' };
        if (isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error)) {
          // The cooldown is keyed per host, as `isGitHubRateLimited` above.
          rateLimit.noteGitHubRateLimit(error, host);
          return { status: 'unavailable' };
        }
        throw error;
      }
    },

    async gitlab({ instance, accountId = null, pulls, issues }) {
      if (!(readGitLabLiveSummaries instanceof Function)) return { status: 'disconnected' };
      const result = await readGitLabLiveSummaries({ instance, accountId, refs: pulls, issueRefs: issues });
      if (!result.connected) return { status: 'disconnected' };
      return { status: 'ok', pulls: result.summaries, issues: result.issueSummaries };
    },

    async linear({ identifiers }) {
      const { getLinearIssueSummaries } = await loadLinear();
      const result = await getLinearIssueSummaries(identifiers);
      if (!result?.connected) return { status: 'disconnected' };
      return { status: 'ok', issues: result.issues };
    },
  };
}
