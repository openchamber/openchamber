import { z } from 'zod';
import type { Octokit } from '@octokit/rest';

const PULL_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const;

const STACK_LAYER_LIMIT = 50;

type PullRequestQuery = { octokit: Octokit; owner: string; repo: string; number: number };

const STACK_QUERY = `
query PullStack($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        stack {
          number
          baseRefName
          entries(first: ${STACK_LAYER_LIMIT}) {
            nodes { position pullRequest { number title url state isDraft headRefName } }
          }
        }
      }
    }
  }
}
`;

const stackSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.object({
      __typename: z.string(),
      stack: z.object({
        number: z.number().int(),
        baseRefName: z.string(),
        entries: z.object({
          nodes: z.array(z.object({
            position: z.number().int(),
            pullRequest: z.object({
              number: z.number().int(),
              title: z.string(),
              url: z.string(),
              state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
              isDraft: z.boolean(),
              headRefName: z.string(),
            }).nullable(),
          })),
        }),
      }).nullable().optional(),
    }).nullable(),
  }).nullable(),
});

export async function fetchPullStack({ octokit, owner, repo, number }: PullRequestQuery) {
  const parsed = stackSchema.parse(await octokit.graphql(STACK_QUERY, { owner, repo, number }));
  const stack = parsed.repository?.issueOrPullRequest?.stack;
  if (!stack) return null;
  const layers = stack.entries.nodes
    .flatMap((entry) => {
      const pullRequest = entry.pullRequest;
      if (!pullRequest) return [];
      return [{
        position: entry.position,
        number: pullRequest.number,
        title: pullRequest.title,
        url: pullRequest.url,
        state: PULL_STATES[pullRequest.state],
        draft: pullRequest.isDraft,
        head: pullRequest.headRefName,
      }];
    })
    .sort((left, right) => left.position - right.position)
    .map(({ position: _position, ...layer }) => layer);
  return { number: stack.number, base: stack.baseRefName, layers };
}
