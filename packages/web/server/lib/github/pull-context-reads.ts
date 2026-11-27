import {
  mapComment,
  mapFile,
  mapReviewComment,
  requireGitHubComment,
  requireGitHubPullFile,
  requireGitHubReviewComment,
  requireProviderArray,
} from './mappers.js';
import { readReviewContext } from './review-summaries.js';
import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

type Rest = RestEndpointMethodTypes;
type Identity = Parameters<typeof mapComment>[1];

const settled = <T>(read: PromiseSettledResult<T>): T => {
  if (read.status === 'rejected') throw read.reason;
  return read.value;
};

export const readPullContextParts = async <Checks, Diff>({ octokit, route, number, identity, requestedReviewers, readChecks, readDiff }: {
  octokit: Octokit;
  route: { owner: string; repo: string };
  number: number;
  identity: Identity;
  requestedReviewers: Parameters<typeof readReviewContext>[3];
  readChecks: () => Promise<Checks>;
  readDiff: () => Promise<Diff>;
}) => {
  const [issueComments, reviewComments, files, checks, diff, reviewFields] = await Promise.allSettled([
    octokit.rest.issues.listComments({ ...route, issue_number: number, per_page: 100 })
      .then((response: Rest['issues']['listComments']['response']) => requireProviderArray<Rest['issues']['listComments']['response']['data'][number]>(
        response?.data,
        'GitHub returned an invalid issue comment list',
      ).map((comment) => mapComment(requireGitHubComment(comment, 'GitHub returned an invalid issue comment'), identity))),
    octokit.rest.pulls.listReviewComments({ ...route, pull_number: number, per_page: 100 })
      .then((response: Rest['pulls']['listReviewComments']['response']) => requireProviderArray(
        response?.data,
        'GitHub returned an invalid review comment list',
      ).map((comment) => mapReviewComment(requireGitHubReviewComment(comment), identity))),
    octokit.rest.pulls.listFiles({ ...route, pull_number: number, per_page: 100 })
      .then((response: Rest['pulls']['listFiles']['response']) => requireProviderArray<Rest['pulls']['listFiles']['response']['data'][number]>(
        response?.data,
        'GitHub returned an invalid pull request file list',
      ).map((file) => mapFile(requireGitHubPullFile(file)))),
    readChecks(),
    readDiff(),
    readReviewContext(octokit, route, number, requestedReviewers, identity),
  ]);
  return {
    issueComments: settled(issueComments),
    reviewComments: settled(reviewComments),
    files: settled(files),
    checks: settled(checks),
    diff: settled(diff),
    reviewFields: settled(reviewFields),
  };
};
