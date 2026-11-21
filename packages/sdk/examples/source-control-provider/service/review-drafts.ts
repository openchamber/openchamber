import type {
  SourceControlJsonObject,
  SourceControlMutationResult,
  SourceControlOutboundMethod,
  SourceControlReconcileData,
} from '@openchamber/sdk';

export type ReviewCall = {
  session: { instance: string; handle: string; user: { id: number | string; login: string } | null };
  identity: { provider: string; instance: string };
};

export type ReviewRepo = { owner: string; name: string };
export type ReviewTarget = ReviewRepo & { number?: number };

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
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  side?: string;
  user?: ReviewUser;
};
type Review = {
  id: number;
  state: string;
  body?: string;
  user?: ReviewUser;
  dismissed?: boolean;
};

export type ReviewDraftsDeps = {
  api: <T>(
    call: ReviewCall,
    method: SourceControlOutboundMethod,
    path: string,
    options?: { query?: Record<string, string>; body?: SourceControlJsonObject },
  ) => Promise<{ data: T }>;
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

const draftCommentOf = (comment: ReviewComment): ReviewDraftCommentData => ({
  id: String(comment.id),
  path: comment.path,
  side: comment.side === 'LEFT' ? 'old' : 'new',
  line: comment.line ?? comment.original_line ?? null,
  startLine: comment.start_line ?? null,
  body: comment.body,
  author: personOf(comment.user),
});

export const createReviewDrafts = (deps: ReviewDraftsDeps) => {
  const { api, repoPath, text, integer, objectOf, selectorOf, resolveRepo, readPull, fail } = deps;

  const viewerOf = (call: ReviewCall): string => {
    const login = call.session.user?.login;
    if (!login) throw fail('A review needs a signed-in account', 401);
    return login;
  };

  const reviewsOf = async (call: ReviewCall, repo: ReviewRepo, number: number): Promise<Review[]> => (
    (await api<Review[]>(call, 'GET', `${repoPath(repo)}/pulls/${number}/reviews`)).data
  );

  const commentsOf = async (
    call: ReviewCall,
    repo: ReviewRepo,
    number: number,
    reviewId: number,
  ): Promise<ReviewComment[]> => (
    (await api<ReviewComment[]>(call, 'GET', `${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/comments`)).data
  );

  const pendingOf = (reviews: Review[], login: string): Review | null => (
    reviews.find((review) => review.state === 'PENDING' && review.user?.login === login) ?? null
  );

  const ensurePending = async (call: ReviewCall, repo: ReviewRepo, number: number, login: string): Promise<Review> => {
    const found = pendingOf(await reviewsOf(call, repo, number), login);
    if (found) return found;
    const created = await api<Review>(call, 'POST', `${repoPath(repo)}/pulls/${number}/reviews`, {
      body: { body: '', event: 'PENDING' },
    });
    return created.data;
  };

  const requiredPending = async (call: ReviewCall, repo: ReviewRepo, number: number, login: string): Promise<Review> => {
    const found = pendingOf(await reviewsOf(call, repo, number), login);
    if (!found) throw fail('There is no pending review on this pull request', 404);
    return found;
  };

  const reviewState = async (
    call: ReviewCall,
    input: SourceControlJsonObject,
  ): Promise<ReviewStateData> => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'), selectorOf(input, 'project'));
    const number = integer(input, 'number');
    const [pull, reviews] = await Promise.all([readPull(call, project, number), reviewsOf(call, project, number)]);
    const login = call.session.user?.login ?? '';
    const pending = pendingOf(reviews, login);
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
        const login = viewerOf(call);
        const pending = await ensurePending(call, providerTarget, number, login);
        const position = objectOf(normalized, 'position');
        const payload: SourceControlJsonObject = { body: text(normalized, 'body'), path: text(position, 'path') };
        const line = integer(position, 'line');
        const startLine = integer(position, 'startLine');
        const side = text(position, 'side');
        if (line) payload.line = line;
        if (startLine) payload.start_line = startLine;
        if (side) payload.side = side === 'old' ? 'LEFT' : 'RIGHT';
        await api(call, 'POST', `${repo}/pulls/${number}/reviews/${pending.id}/comments`, { body: payload });
        return {};
      }
      case 'change-request-review-comment-update':
      case 'change-request-review-comment-delete': {
        const login = viewerOf(call);
        const pending = await requiredPending(call, providerTarget, number, login);
        const commentId = text(normalized, 'commentId');
        const comments = await commentsOf(call, providerTarget, number, pending.id);
        if (!comments.some((comment) => String(comment.id) === commentId)) {
          throw fail('The comment is not in the pending review', 409, 'SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        }
        const path = `${repo}/pulls/${number}/reviews/${pending.id}/comments/${commentId}`;
        if (kind === 'change-request-review-comment-update') {
          await api(call, 'PATCH', path, { body: { body: text(normalized, 'body') } });
        } else {
          await api(call, 'DELETE', path);
        }
        return {};
      }
      case 'change-request-review-discard': {
        const login = viewerOf(call);
        const pending = pendingOf(await reviewsOf(call, providerTarget, number), login);
        if (!pending) return {};
        await api(call, 'DELETE', `${repo}/pulls/${number}/reviews/${pending.id}`);
        return {};
      }
      case 'change-request-review-dismiss': {
        const reviewId = text(normalized, 'reviewId');
        if (!reviewId) throw fail('reviewId is required', 400);
        const dismissed = normalized.dismissed !== false;
        const message = text(normalized, 'message');
        if (dismissed && !message) throw fail('A dismissal needs a message', 400);
        const action = dismissed ? 'dismissals' : 'undismissals';
        await api(call, 'POST', `${repo}/pulls/${number}/reviews/${reviewId}/${action}`, dismissed ? { body: { message } } : {});
        return {};
      }
      default:
        throw fail(`${kind} is not a review write this Git host offers`, 501, 'UNSUPPORTED');
    }
  };

  const reconcile = async (
    call: ReviewCall,
    kind: string,
    normalized: SourceControlJsonObject,
    providerTarget: ReviewTarget,
  ): Promise<SourceControlReconcileData> => {
    const number = providerTarget.number ?? 0;
    if (kind === 'change-request-review-discard') {
      const login = call.session.user?.login ?? '';
      const pending = pendingOf(await reviewsOf(call, providerTarget, number), login);
      return pending ? { state: 'outcome-unknown' } : { state: 'succeeded', result: {} };
    }
    if (kind === 'change-request-review-dismiss') {
      const reviewId = text(normalized, 'reviewId');
      const dismissed = normalized.dismissed !== false;
      const found = (await reviewsOf(call, providerTarget, number)).find((review) => String(review.id) === reviewId);
      const isDismissed = found?.dismissed === true || found?.state === 'DISMISSED';
      const landed = found !== undefined && isDismissed === dismissed;
      return landed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    }
    return { state: 'outcome-unknown' };
  };

  return { reviewState, perform, reconcile };
};

export type Reviews = ReturnType<typeof createReviewDrafts>;
