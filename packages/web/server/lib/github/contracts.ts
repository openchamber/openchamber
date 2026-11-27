import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import { z } from 'zod';
import type { GitHubReviewerState } from './reviewer-states.js';
import type { acrossContextSchema, detailCommentSchema, acrossRequestSchema, stateSchema, peopleSchema, toReference } from './reference-search.js';
import type { fetchPullStack } from './pull-stack.js';
import type { summarizeCheckContexts } from './pr-summaries.js';
export type { SummaryRef } from './pr-summaries.js';
export type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
export type AcrossContext = z.infer<typeof acrossContextSchema>;
type DetailComment = z.infer<typeof detailCommentSchema>;
interface ReferenceFilters { kind: z.infer<typeof acrossRequestSchema>['kind']; state: z.infer<typeof stateSchema>; people: z.infer<typeof peopleSchema> }
export type AcrossSearchInput<Group extends AcrossGroup> = Omit<SearchInput, 'octokit' | 'repos'> & {
  groups: Group[]; onGroupError: (group: Group, error: GitHubEnvelope['data']) => Promise<void>;
};
export const isDiscoveryText = (value: unknown): value is string => typeof value === 'string';
export const isCacheIdentity = (value: unknown): value is string => Object.prototype.toString.call(value) === '[object String]';

export type ItemState = 'open' | 'closed';
export type DiscoveryPull = RestEndpointMethodTypes['pulls']['list']['response']['data'][number];
export type DiscoveryMetadata = RestEndpointMethodTypes['repos']['get']['response']['data'];
export interface DiscoveryRepository { owner: string; repo: string; host?: string | null; url?: string }
export interface MutationPull {
  number: number;
  state: ItemState;
  merged?: unknown;
  merged_at?: unknown;
  draft?: unknown;
  node_id?: string;
  head: { ref: string; sha: string; repo?: { owner: { login: string }; name: string } | null };
  base: { ref: string; repo: { owner: { login: string }; name: string; default_branch?: unknown } };
}
export interface RemoteCandidate { repo: DiscoveryRepository; remoteName: string }
export interface RankedCandidate extends RemoteCandidate { priority: number }
export interface HistoricalEntry { pr: DiscoveryPull | null; fetchedAt: number }
export interface PullList { fetchedAt: number; prs: DiscoveryPull[]; complete: boolean; promise?: never; token?: never }
export interface PendingPullList { promise: Promise<PullList>; token: { invalidated: boolean }; fetchedAt?: never }
export interface StatusInput {
  octokit: Octokit; directory: string; branch: string; remoteName?: string; sourceRemoteName?: string | null;
  force?: boolean; requestHost?: string | null | undefined;
}
export interface FoundPull { repo: DiscoveryRepository; pr: DiscoveryPull; defaultBranch: string | null; resolvedRemoteName: string | null }
export interface FindBranchPrInput {
  octokit: Octokit; target: RemoteCandidate; branch: string; sourceCandidates: RemoteCandidate[];
  force?: boolean; coverage?: { authoritative: boolean } | null; includeHistory?: boolean;
}
export interface ReferenceRepo { owner: string; repo: string; source: 'origin' | 'upstream'; directory?: string }
export type Reference = NonNullable<ReturnType<typeof toReference>>;
export type DetailLineComment = DetailComment & {
  path: string | null; line: number | null; originalLine: number | null;
  startLine?: number | null | undefined; originalStartLine?: number | null | undefined; diffHunk?: string | null | undefined;
};
export interface DetailEntry {
  author: { login: string; avatarUrl: string | undefined } | null;
  body: string; createdAt: string | null; url: string; path: string | null; line: number | null;
  review: string | null; id?: string; canUpdate?: boolean; canDelete?: boolean;
  excerpt?: { startLine: number; lines: string[] };
  thread?: { id: string; resolved: boolean; canResolve: boolean; canReply: boolean; outdated?: boolean; replies: DetailEntry[] };
  answer?: { chosen: boolean; canChange: boolean };
}
export interface ReferenceReview {
  id?: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'pending' | 'dismissed';
  author: { login: string; avatarUrl: string | undefined } | null;
  submittedAt: string | null;
}
export interface StatusDictionary { [key: string]: string | undefined }
export interface SearchInput extends ReferenceFilters {
  octokit: Octokit; repos: ReferenceRepo[]; text: string; labels?: string[] | undefined; cursor: string | null;
}
export interface AcrossGroup {
  accountId: string; octokit: Octokit; authority: AcrossContext[]; host?: string;
  repos: (ReferenceRepo & { directory: string })[];
}
export interface AcrossPosition { cursor: string | null; offset: number; done: boolean; total: number }
export interface CommentPermissions { canUpdate?: boolean; canDelete?: boolean }
export interface EditableText { body?: string; viewerCanUpdate?: boolean }
export interface ReferenceAssignee { id: string; login: string; avatarUrl?: string | undefined }
export interface ReferenceDetail extends EditableText {
  number: number; comments: DetailEntry[]; commentTotal: number;
  writeAccess?: boolean; threadsUnavailable?: boolean;
  branchWriteAccess?: boolean;
  assignees?: ReferenceAssignee[];
  pull: {
    reviewDecision: string | null; reviewers: { id: string; login?: string; avatarUrl?: string | undefined }[];
    reviewerStates?: GitHubReviewerState[];
    checks: ReturnType<typeof summarizeCheckContexts> | null; additions: number; deletions: number; changedFiles: number;
    commits: { sha: string; headline: string; author: { login: string; avatarUrl: string | undefined } | null; authorName: string | null; committedAt: string | null; url: string | null }[];
    reviews?: ReferenceReview[];
    canDismissReviews?: boolean;
    commitTotal: number; stack?: Awaited<ReturnType<typeof fetchPullStack>>;
  } | null;
}
export interface LookupVariables { number: number; [name: string]: string | number }
type LocatedReference = Reference & { directory: string };
export type AcrossPage = { done: true; items: LocatedReference[]; total: number; error?: never } | {
  done: false; items: LocatedReference[]; hasMore: boolean; endCursor: string | null; total: number; error?: never;
} | { error: unknown; done?: never };

export function retainedEntry<Entry>(entries: Entry[], index: number) {
  const entry = entries[index];
  if (entry === undefined) throw new Error('Missing reference search entry');
  return entry;
}

export function referenceDirectory(repos: AcrossGroup['repos'], item: Reference, repoKey: (owner: string, repo: string) => string) {
  const repo = repos.find((entry) => repoKey(entry.owner, entry.repo) === repoKey(item.sourceRepo.owner, item.sourceRepo.repo));
  if (!repo) throw new Error('Missing reference repository');
  return repo.directory;
}

export function livePage(page: AcrossPage) {
  if (page.done !== false) throw new Error('Missing reference search page');
  return page;
}

export const graphqlAliasesSchema = z.record(z.string(), z.unknown()).catch({});
export function referenceNodeAt(data: z.infer<typeof graphqlAliasesSchema>, index: number, field: 'discussion' | 'issueOrPullRequest') {
  const repository = data[`a${index}`];
  return hasProperty(repository, field) ? repository[field] : undefined;
}

export interface PullRequestQuery {
  octokit: Octokit;
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubEnvelope {
  status?: unknown;
  code?: unknown;
  error_description?: unknown;
  error?: unknown;
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  enablePullRequestAutoMerge?: unknown;
  disablePullRequestAutoMerge?: unknown;
  pullRequest?: unknown;
  queueRemoval?: unknown;
  autoMergeRequest?: unknown;
  enabledAt?: unknown;
  repository?: unknown;
  reviews?: unknown;
  nodes?: unknown;
  viewerDidAuthor?: unknown;
  commit?: unknown;
  oid?: unknown;
  id?: unknown;
  errors?: unknown;
  path?: unknown;
  data?: unknown;
  type?: unknown;
  issue?: unknown;
  discussion?: unknown;
  __typename?: unknown;
  login?: unknown;
  issueOrPullRequest?: unknown;
  name?: unknown;
}

export const hasProperty = <Key extends keyof GitHubEnvelope>(value: unknown, key: Key): value is Required<Pick<GitHubEnvelope, Key>> =>
  value != null && key in Object(value);

const hasGraphQLField = <Key extends string>(value: unknown, _key: Key): value is { [Name in Key]?: unknown } =>
  value != null;
export const fieldAt = <Key extends string>(value: GitHubEnvelope['data'], key: Key) =>
  hasGraphQLField(value, key) ? value[key] : undefined;
export const gqlPath = (value: GitHubEnvelope['data'], ...keys: string[]) => keys.reduce<GitHubEnvelope['data']>(fieldAt, value);
export const requireField = <Value>(value: Value, name: string): NonNullable<Value> => {
  if (value == null) throw new TypeError(`GitHub mutation field ${name} is missing`);
  return value;
};
