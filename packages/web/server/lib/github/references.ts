import { z } from 'zod';
import type { Octokit } from '@octokit/rest';

export interface GitHubReferenceLink {
  kind: 'issue' | 'pull';
  number: number;
  url: string;
  createdAt: string | null;
  author: { login: string; avatarUrl?: string } | null;
  title?: string;
  repo?: string;
  willCloseTarget?: boolean;
}

const toAuthor = (author: { login: string; avatarUrl?: string | null | undefined } | null): GitHubReferenceLink['author'] =>
  (!author ? null : (author.avatarUrl ? { login: author.login, avatarUrl: author.avatarUrl } : { login: author.login }));

const crossReferenceSchema = z.object({
  createdAt: z.string().nullable().optional(),
  willCloseTarget: z.boolean().nullable().optional(),
  actor: z.object({ login: z.string(), avatarUrl: z.string().nullable().optional() }).nullable().optional(),
  source: z.object({
    __typename: z.string(),
    number: z.number().int().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    repository: z.object({ nameWithOwner: z.string() }).nullable().optional(),
  }).nullable().optional(),
});

const CROSS_REFERENCED_EVENTS = `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 20) {
          nodes {
            ... on CrossReferencedEvent {
              createdAt
              willCloseTarget
              actor { login avatarUrl }
              source {
                __typename
                ... on Issue { number title url repository { nameWithOwner } }
                ... on PullRequest { number title url repository { nameWithOwner } }
              }
            }
          }
        }`;

const REFERENCE_LINKS_QUERY = `
query ReferenceLinks($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      ... on Issue { ${CROSS_REFERENCED_EVENTS} }
      ... on PullRequest { ${CROSS_REFERENCED_EVENTS} }
    }
  }
}
`;

const referenceLinksSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.object({
      timelineItems: z.object({ nodes: z.array(crossReferenceSchema.nullable().catch(null)).nullable() }).optional(),
    }).nullable(),
  }).nullable(),
});

type CrossReference = z.infer<typeof crossReferenceSchema>;

const toReference = (node: CrossReference | null): GitHubReferenceLink[] => {
  if (!node) return [];
  const source = node.source;
  const number = Number(source?.number);
  if (!source || !Number.isSafeInteger(number) || !source.url) return [];
  const reference: GitHubReferenceLink = {
    kind: source.__typename === 'PullRequest' ? 'pull' : 'issue',
    number,
    url: source.url,
    createdAt: node.createdAt ?? null,
    author: toAuthor(node.actor ?? null),
  };
  if (source.title) reference.title = source.title;
  if (source.repository?.nameWithOwner) reference.repo = source.repository.nameWithOwner;
  if (node.willCloseTarget != null) reference.willCloseTarget = node.willCloseTarget;
  return [reference];
};

export async function fetchReferenceLinks({ octokit, owner, repo, number }: {
  octokit: Octokit; owner: string; repo: string; number: number;
}): Promise<GitHubReferenceLink[]> {
  const parsed = referenceLinksSchema.parse(await octokit.graphql(REFERENCE_LINKS_QUERY, { owner, repo, number }));
  return (parsed.repository?.issueOrPullRequest?.timelineItems?.nodes ?? []).flatMap(toReference);
}

export const referencesField = async (
  octokit: Octokit, owner: string, repo: string, number: number,
): Promise<{ references?: GitHubReferenceLink[] }> => {
  const references = await fetchReferenceLinks({ octokit, owner, repo, number }).catch((): GitHubReferenceLink[] => []);
  return references.length > 0 ? { references } : {};
};
