/**
 * Free-text PR search hits need a follow-up `pulls.get` for base/head/mergeable.
 * Per-item enrichment can fail (rate limit, timeout, network) while search itself
 * succeeded. Callers must still see every hit; missing details set `incomplete`.
 */

export function mapPullRequestSummary(pr, repoRef) {
  const mergedState = pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open');
  const headRepo = pr.head?.repo
    ? {
        owner: pr.head.repo.owner?.login,
        repo: pr.head.repo.name,
        url: pr.head.repo.html_url,
        cloneUrl: pr.head.repo.clone_url,
        sshUrl: pr.head.repo.ssh_url,
      }
    : null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: mergedState,
    draft: Boolean(pr.draft),
    base: pr.base?.ref,
    head: pr.head?.ref,
    headSha: pr.head?.sha,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    author: pr.user ? { login: pr.user.login, id: pr.user.id, avatarUrl: pr.user.avatar_url } : null,
    headLabel: pr.head?.label,
    headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url
      ? headRepo
      : null,
    sourceRepo: { owner: repoRef.owner, repo: repoRef.repo, source: repoRef.source },
  };
}

export function mapSearchHitPullRequestSummary(item, repoRef) {
  const mergedState = item?.pull_request?.merged_at
    ? 'merged'
    : (item?.state === 'closed' ? 'closed' : 'open');
  return {
    number: item.number,
    title: typeof item.title === 'string' ? item.title : '',
    url: typeof item.html_url === 'string' ? item.html_url : '',
    state: mergedState,
    draft: Boolean(item.draft),
    base: typeof item.base?.ref === 'string' ? item.base.ref : '',
    head: typeof item.head?.ref === 'string' ? item.head.ref : '',
    author: item.user
      ? { login: item.user.login, id: item.user.id, avatarUrl: item.user.avatar_url }
      : null,
    sourceRepo: { owner: repoRef.owner, repo: repoRef.repo, source: repoRef.source },
  };
}

function resolveSearchItemRepo(item, reposToQuery) {
  const repositoryUrl = typeof item?.repository_url === 'string' ? item.repository_url : '';
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!match) return reposToQuery[0] ?? null;
  return reposToQuery.find((repoRef) => repoRef.owner === match[1] && repoRef.repo === match[2])
    || reposToQuery[0]
    || null;
}

export async function summarizeSearchPullRequests({
  octokit,
  items,
  reposToQuery,
  incompleteResults = false,
}) {
  const list = Array.isArray(items) ? items : [];
  const mappedRefs = [];
  let unmappedCount = 0;
  for (const item of list) {
    const number = item?.number;
    const repoRef = resolveSearchItemRepo(item, reposToQuery);
    if (!Number.isFinite(number) || number <= 0 || !repoRef) {
      unmappedCount += 1;
      continue;
    }
    mappedRefs.push({ number, repoRef, item });
  }

  const results = await Promise.all(mappedRefs.map(async ({ number, repoRef, item }) => {
    try {
      const pr = await octokit.rest.pulls.get({
        owner: repoRef.owner,
        repo: repoRef.repo,
        pull_number: number,
      });
      if (!pr?.data) {
        throw new Error('Empty pull request payload');
      }
      return { pr: mapPullRequestSummary(pr.data, repoRef), incomplete: false };
    } catch (error) {
      console.warn(
        `Failed to enrich PR ${repoRef.owner}/${repoRef.repo}#${number}:`,
        error?.message || error,
      );
      return { pr: mapSearchHitPullRequestSummary(item, repoRef), incomplete: true };
    }
  }));

  return {
    prs: results.map((result) => result.pr),
    incomplete: incompleteResults || unmappedCount > 0 || results.some((result) => result.incomplete),
  };
}
