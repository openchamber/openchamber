// Collection readers for GitHub REST collections (fork design #1528, phase 1:
// issue #1529). A collection read is complete, or it says so: each reader
// paginates to a short page under a named cap, probes one page past the cap,
// and errors when the probe is non-empty, so a partial list is never returned
// as if it were complete. These came from the fork's github/collections.js and
// github/routes.js; upstream's provider split (resources.ts) read one page or
// paged without a bound, so the merge keeps the fork's readers here.

import { requireGitHubCheckRuns, requireGitHubWorkflowJobs, requireProviderArray } from './mappers.js';
import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

type Rest = RestEndpointMethodTypes;

export const GITHUB_COLLECTION_PAGE_SIZE = 100;
const GITHUB_COLLECTION_MAX_PAGES = 20;
export const GITHUB_COLLECTION_MAX_COUNT = GITHUB_COLLECTION_PAGE_SIZE * GITHUB_COLLECTION_MAX_PAGES;

/** The error a collection that crosses the cap answers with, for example `GitHub pull request file list reached the 2000 safety limit ...`. */
export const collectionLimitError = (label: string) => new Error(`GitHub ${label} list reached the ${GITHUB_COLLECTION_MAX_COUNT} safety limit and may be incomplete`);

/**
 * Every item of a plain-array collection: pages until a short page, and at the
 * cap reads one probe page; a non-empty probe is `limitError()`. A page error
 * propagates, so a caller never gets the pages read so far as the whole list
 * (#1375, #1383, #1420, and the branch list).
 */
export async function readCappedCollection<Item>(limitError: () => Error, readPage: (page: number) => Promise<Item[]>): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; page <= GITHUB_COLLECTION_MAX_PAGES; page += 1) {
    const payload = await readPage(page);
    items.push(...payload);
    if (payload.length < GITHUB_COLLECTION_PAGE_SIZE) return items;
    if (page === GITHUB_COLLECTION_MAX_PAGES) {
      if ((await readPage(page + 1)).length === 0) return items;
      throw limitError();
    }
  }
  return items;
}

/**
 * Every item of a `{ total_count, items }` collection (check runs for a ref,
 * jobs of a workflow run) under the same cap (#1405). The first page's
 * total_count ends the read as soon as it is covered, and a short page that
 * still leaves items unread is an error, never an ending.
 */
export async function readTotalCountCollection<Item>(
  label: string,
  readPage: (page: number) => Promise<{ items: Item[]; totalCount: number | undefined }>,
): Promise<Item[]> {
  const items: Item[] = [];
  let totalCount: number | null = null;
  for (let page = 1; page <= GITHUB_COLLECTION_MAX_PAGES; page += 1) {
    const { items: payload, totalCount: reported } = await readPage(page);
    if (page === 1 && Number.isSafeInteger(reported) && Number(reported) >= 0) totalCount = Number(reported);
    items.push(...payload);
    if (totalCount !== null && items.length >= totalCount) return items;
    if (payload.length < GITHUB_COLLECTION_PAGE_SIZE) {
      if (totalCount !== null && items.length < totalCount) {
        throw new Error(`GitHub ${label} list ended after ${items.length} of ${totalCount} entries and may be incomplete`);
      }
      return items;
    }
    if (page === GITHUB_COLLECTION_MAX_PAGES) {
      const probe = (await readPage(page + 1)).items;
      if (probe.length === 0 && (totalCount === null || items.length >= totalCount)) return items;
      throw collectionLimitError(label);
    }
  }
  return items;
}

type RepoRoute = { owner: string; repo: string };
const routeOf = ({ owner, repo }: RepoRoute) => ({ owner, repo });

/** Check runs for a ref (#1405): a read past the cap errors, so the caller falls back instead of summarising a partial list. */
export const readCheckRunPages = (octokit: Octokit, repo: RepoRoute, ref: string) => readTotalCountCollection<Rest['checks']['listForRef']['response']['data']['check_runs'][number]>('check run', async (page) => {
  const data = (await octokit.rest.checks.listForRef({ ...routeOf(repo), ref, per_page: GITHUB_COLLECTION_PAGE_SIZE, page }))?.data;
  return { items: requireGitHubCheckRuns(data?.check_runs), totalCount: data?.total_count };
});

/** Jobs of one workflow run, under the same total_count discipline as check runs. */
export const readWorkflowJobPages = (octokit: Octokit, repo: RepoRoute, runId: number) => readTotalCountCollection<Rest['actions']['listJobsForWorkflowRun']['response']['data']['jobs'][number]>('workflow job', async (page) => {
  const data = (await octokit.rest.actions.listJobsForWorkflowRun({ ...routeOf(repo), run_id: runId, per_page: GITHUB_COLLECTION_PAGE_SIZE, page }))?.data;
  return { items: requireGitHubWorkflowJobs(data?.jobs), totalCount: data?.total_count };
});

/** One check run's annotations (#1420); the caller flags the run when this throws. */
export const readAnnotationPages = (octokit: Octokit, repo: RepoRoute, checkRunId: number) => readCappedCollection(
  () => collectionLimitError('check run annotation'),
  async (page) => requireProviderArray<Rest['checks']['listAnnotations']['response']['data'][number]>(
    (await octokit.rest.checks.listAnnotations({ ...routeOf(repo), check_run_id: checkRunId, per_page: GITHUB_COLLECTION_PAGE_SIZE, page }))?.data,
    'GitHub returned an invalid check run annotation list',
  ),
);

/** Comments on an issue or pull request (#1375, #1383). */
export const readIssueCommentPages = (octokit: Octokit, repo: RepoRoute, number: number) => readCappedCollection(
  () => collectionLimitError('issue comment'),
  async (page) => requireProviderArray<Rest['issues']['listComments']['response']['data'][number]>(
    (await octokit.rest.issues.listComments({ ...routeOf(repo), issue_number: number, per_page: GITHUB_COLLECTION_PAGE_SIZE, page }))?.data,
    'GitHub returned an invalid issue comment list',
  ),
);

/** Review comments of a pull request (#1375). */
export const readReviewCommentPages = (octokit: Octokit, repo: RepoRoute, number: number) => readCappedCollection(
  () => collectionLimitError('review comment'),
  async (page) => requireProviderArray<Rest['pulls']['listReviewComments']['response']['data'][number]>(
    (await octokit.rest.pulls.listReviewComments({ ...routeOf(repo), pull_number: number, per_page: GITHUB_COLLECTION_PAGE_SIZE, page }))?.data,
    'GitHub returned an invalid review comment list',
  ),
);

/** Files of a pull request (#1375). */
export const readPullFilePages = (octokit: Octokit, repo: RepoRoute, number: number) => readCappedCollection(
  () => collectionLimitError('pull request file'),
  async (page) => requireProviderArray<Rest['pulls']['listFiles']['response']['data'][number]>(
    (await octokit.rest.pulls.listFiles({ ...routeOf(repo), pull_number: number, per_page: GITHUB_COLLECTION_PAGE_SIZE, page }))?.data,
    'GitHub returned an invalid pull request file list',
  ),
);

/** The branch list keeps the fork's wording for its limit. */
export const branchLimitError = () => new Error(`GitHub branch list reached the ${GITHUB_COLLECTION_MAX_COUNT}-branch safety limit and may be incomplete`);
