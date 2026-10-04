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
    async github({ accountId = null, pulls, issues }) {
      const [github, { fetchPrSummaries, isGraphqlRateLimitError }, rateLimit] = await Promise.all([
        loadGitHub(), loadGitHubSummaries(), loadGitHubRateLimit(),
      ]);
      if (rateLimit.isGitHubRateLimited()) return { status: 'unavailable' };
      // A bound repository is read with its own account, a linked item with the current one.
      const octokit = accountId
        ? (await github.getOctokitForAccountId(accountId))?.octokit ?? null
        : await github.getOctokitOrNull();
      if (!octokit) return { status: 'disconnected' };
      try {
        const { summaries, issueSummaries } = await fetchPrSummaries({ octokit, refs: pulls, issueRefs: issues });
        return { status: 'ok', pulls: summaries, issues: issueSummaries };
      } catch (error) {
        if ((error?.status ?? error?.response?.status) === 401) return { status: 'disconnected' };
        if (isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error)) {
          // The shared cooldown also holds back every other GitHub read.
          rateLimit.noteGitHubRateLimit(error);
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
