import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { normalizePath } from '@/lib/pathNormalization';
import { splitProjectPath } from '@/lib/source-control/projectPath';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import { getRuntimeKey } from '@/lib/runtime-switch';

export type ComparisonCommentOrigin = Extract<DiffCommentOrigin, { kind: 'commit' | 'branch' | 'change-request' }>;

export type CommentComparisonScope = 'branch' | 'commit' | 'pr';

export type CommentLocationRequest = {
  runtimeKey: string;
  directory: string;
  filePath: string;
  line: number | null;
  side: 'additions' | 'deletions';
  origin: ComparisonCommentOrigin;
};

export const commentComparisonScope = (origin: ComparisonCommentOrigin): CommentComparisonScope => (
  origin.kind === 'change-request' ? 'pr' : origin.kind
);

export const pullRequestSourceOf = (origin: Extract<ComparisonCommentOrigin, { kind: 'change-request' }>): PullRequestSource => {
  const source: PullRequestSource = { kind: 'pr', number: origin.number };
  if (origin.repository) source.sourceRepo = splitProjectPath(origin.repository);
  if (origin.revision && origin.provider && readSourceControlProvider(origin.provider).features.revisions) {
    source.revision = origin.revision;
  }
  return source;
};

export const commentRepository = (request: CommentLocationRequest): string => request.origin.directory ?? request.directory;

export const isCommentLocationFor = (request: CommentLocationRequest, directory: string | null | undefined): boolean => (
  Boolean(directory)
  && request.runtimeKey === getRuntimeKey()
  && normalizePath(request.directory) === normalizePath(directory ?? '')
);
