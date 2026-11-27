import type {
  SourceControlJsonObject,
  SourceControlMutationResult,
  SourceControlOutboundMethod,
  SourceControlReconcileData,
} from '@openchamber/sdk';

const DRAFT_REVIEW_BODY = '\u200b';

export type ReviewCall = {
  session: { instance: string; handle: string; user: { id: number | string; login: string } | null };
  identity: { provider: string; instance: string };
};

export type ReviewRepo = { owner: string; name: string };
export type ReviewTarget = ReviewRepo & { number?: number; headSha?: string };

type ReviewUser = { login: string; avatar_url?: string };
type ReviewPersonData = { login: string; avatarUrl?: string };
export type ReviewDraftCommentData = {
  id: string;
  path: string;
  side: 'old' | 'new';
  line: number | null;
  startLine: number | null;
  body: string;
  author: ReviewPersonData | null;
};
export type ReviewStateData = {
  connected: true;
  viewerIsAuthor: boolean;
  headSha: string;
  draft: { id: string; body: string; comments: ReviewDraftCommentData[] } | null;
  threads: never[];
  truncated: boolean;
};
type ReviewPull = { number: number; user?: ReviewUser; head: { sha: string } };
type ReviewComment = {
  id: number;
  body: string;
  path: string;
  position?: number | null;
  original_position?: number | null;
  user?: ReviewUser;
};
type Review = {
  id: number;
  state: string;
  body?: string;
  user?: ReviewUser;
};

const REVIEW_SCAN_PAGES = 10;
const REVIEW_SCAN_SIZE = 50;

export type ReviewDraftsDeps = {
  api: <T>(
    call: ReviewCall,
    method: SourceControlOutboundMethod,
    path: string,
    options?: { query?: Record<string, string>; body?: SourceControlJsonObject },
  ) => Promise<{ data: T; total: number | null }>;
  repoPath: (repo: ReviewRepo) => string;
  text: (input: SourceControlJsonObject, key: string) => string;
  integer: (input: SourceControlJsonObject, key: string) => number;
  objectOf: (input: SourceControlJsonObject, key: string) => SourceControlJsonObject;
  selectorOf: (input: SourceControlJsonObject, key: string) => ReviewRepo | undefined;
  resolveRepo: (
    call: ReviewCall,
    directory: string,
    remote: string,
    project?: ReviewRepo,
  ) => Promise<{ project: ReviewRepo }>;
  readPull: (call: ReviewCall, repo: ReviewRepo, number: number) => Promise<ReviewPull>;
  fail: (message: string, status: number, code?: string) => Error;
};

const personOf = (user: ReviewUser | undefined): ReviewPersonData | null => {
  if (!user) return null;
  return user.avatar_url ? { login: user.login, avatarUrl: user.avatar_url } : { login: user.login };
};

const draftCommentOf = (comment: ReviewComment): ReviewDraftCommentData => {
  const position = Number(comment.position ?? 0);
  const original = Number(comment.original_position ?? 0);
  return {
    id: String(comment.id),
    path: comment.path,
    side: position > 0 ? 'new' : 'old',
    line: position > 0 ? position : original > 0 ? original : null,
    startLine: null,
    body: comment.body,
    author: personOf(comment.user),
  };
};

export const createReviewDrafts = (deps: ReviewDraftsDeps) => {
  const { api, repoPath, text, integer, objectOf, selectorOf, resolveRepo, readPull, fail } = deps;

  const envelopeOf = (input: SourceControlJsonObject) => {
    const resolved = objectOf(input, 'resolved');
    const providerTarget = objectOf(resolved, 'providerTarget');
    const resolvedTarget = objectOf(resolved, 'target');
    return {
      kind: text(input, 'kind'),
      normalized: objectOf(input, 'input'),
      target: {
        owner: text(providerTarget, 'owner'),
        name: text(providerTarget, 'name'),
        number: integer(providerTarget, 'number') || undefined,
        headSha: text(resolvedTarget, 'headSha') || undefined,
      },
    };
  };

  const viewerOf = (call: ReviewCall): string => {
    const login = call.session.user?.login;
    if (!login) throw fail('A review needs a signed-in account', 401);
    return login;
  };

  const pendingOf = async (call: ReviewCall, repo: ReviewRepo, number: number, login: string): Promise<Review | null> => {
    for (let page = 1; page <= REVIEW_SCAN_PAGES; page += 1) {
      const { data, total } = await api<Review[]>(call, 'GET', `${repoPath(repo)}/pulls/${number}/reviews`, {
        query: { page: String(page), limit: String(REVIEW_SCAN_SIZE) },
      });
      const found = data.find((review) => review.state === 'PENDING' && review.user?.login === login);
      if (found) return found;
      // Gitea counts and pages reviews before it hides other users' pending ones, and may
      // cap the page size, so a short page alone does not end the list. It ends on an empty
      // page past the count, or on a first page that holds every row the count promised.
      if (data.length === 0 && (total === null || page * REVIEW_SCAN_SIZE >= total)) return null;
      if (page === 1 && data.length === total) return null;
    }
    throw fail(`The pull request has more reviews than this Git host scans (${REVIEW_SCAN_PAGES * REVIEW_SCAN_SIZE})`, 502, 'SCAN_LIMIT');
  };

  const commentsOf = async (
    call: ReviewCall,
    repo: ReviewRepo,
    number: number,
    reviewId: number,
  ): Promise<ReviewComment[]> => (
    (await api<ReviewComment[]>(call, 'GET', `${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/comments`)).data
  );

  const requiredPending = async (call: ReviewCall, repo: ReviewRepo, number: number, login: string): Promise<Review> => {
    const found = await pendingOf(call, repo, number, login);
    if (!found) throw fail('There is no pending review on this pull request', 404);
    return found;
  };

  const reviewState = async (
    call: ReviewCall,
    input: SourceControlJsonObject,
  ): Promise<ReviewStateData> => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'), selectorOf(input, 'project'));
    const number = integer(input, 'number');
    const login = call.session.user?.login ?? '';
    const [pull, pending] = await Promise.all([readPull(call, project, number), pendingOf(call, project, number, login)]);
    const draft = pending
      ? {
        id: String(pending.id),
        body: pending.body ?? '',
        comments: (await commentsOf(call, project, number, pending.id)).map(draftCommentOf),
      }
      : null;
    return {
      connected: true,
      viewerIsAuthor: login.length > 0 && pull.user?.login === login,
      headSha: pull.head.sha.toLowerCase(),
      draft,
      threads: [],
      truncated: false,
    };
  };

  const perform = async (
    call: ReviewCall,
    kind: string,
    normalized: SourceControlJsonObject,
    providerTarget: ReviewTarget,
  ): Promise<SourceControlMutationResult> => {
    const number = providerTarget.number ?? 0;
    const repo = repoPath(providerTarget);
    switch (kind) {
      case 'change-request-review-comment': {
        viewerOf(call);
        const headSha = providerTarget.headSha;
        if (!headSha) throw fail('The review needs the pull request head', 400, 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT');
        const position = objectOf(normalized, 'position');
        const line = integer(position, 'line');
        if (integer(position, 'startLine')) {
          throw fail('Gitea comments on one line only; select a single line to comment on', 422);
        }
        const comment: SourceControlJsonObject = { path: text(position, 'path'), body: text(normalized, 'body') };
        if (line) {
          const old = text(position, 'side') === 'old';
          comment.new_position = old ? 0 : line;
          comment.old_position = old ? line : 0;
        }
        await api(call, 'POST', `${repo}/pulls/${number}/reviews`, {
          body: { event: 'PENDING', body: DRAFT_REVIEW_BODY, commit_id: headSha, comments: [comment] },
        });
        return {};
      }
      case 'change-request-review-comment-delete':
        // Gitea answers 204 to a DELETE of a review comment and keeps it, so this is refused before any write.
        viewerOf(call);
        throw fail('Gitea cannot remove one review comment; discard the review instead', 422);
      case 'change-request-review-comment-update': {
        const login = viewerOf(call);
        const pending = await requiredPending(call, providerTarget, number, login);
        const commentId = text(normalized, 'commentId');
        const comments = await commentsOf(call, providerTarget, number, pending.id);
        if (!comments.some((comment) => String(comment.id) === commentId)) {
          throw fail('The comment is not in the pending review', 409, 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        }
        await api(call, 'PATCH', `${repo}/issues/comments/${encodeURIComponent(commentId)}`, { body: { body: text(normalized, 'body') } });
        return {};
      }
      case 'change-request-review-discard': {
        const login = viewerOf(call);
        const pending = await pendingOf(call, providerTarget, number, login);
        if (!pending) return {};
        await api(call, 'DELETE', `${repo}/pulls/${number}/reviews/${pending.id}`);
        return {};
      }
      default:
        throw fail(`${kind} is not a review write this Git host offers`, 501, 'UNSUPPORTED');
    }
  };

  const reconcile = async (
    call: ReviewCall,
    kind: string,
    providerTarget: ReviewTarget,
  ): Promise<SourceControlReconcileData> => {
    const number = providerTarget.number ?? 0;
    if (kind === 'change-request-review-discard') {
      const login = call.session.user?.login ?? '';
      const pending = await pendingOf(call, providerTarget, number, login).catch(() => undefined);
      return pending === null ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    }
    return { state: 'outcome-unknown' };
  };

  return {
    reviewState,
    handlers: { reviewState },
    perform: (call: ReviewCall, input: SourceControlJsonObject) => {
      const { kind, normalized, target } = envelopeOf(input);
      return perform(call, kind, normalized, target);
    },
    reconcile: (call: ReviewCall, input: SourceControlJsonObject) => {
      const { kind, target } = envelopeOf(input);
      return reconcile(call, kind, target);
    },
  };
};

export type Reviews = ReturnType<typeof createReviewDrafts>;
