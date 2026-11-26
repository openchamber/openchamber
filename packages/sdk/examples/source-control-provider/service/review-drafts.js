// packages/sdk/examples/source-control-provider/service/review-drafts.ts
var DRAFT_REVIEW_BODY = "​";
var REVIEW_SCAN_PAGES = 10;
var REVIEW_SCAN_SIZE = 50;
var personOf = (user) => {
  if (!user)
    return null;
  return user.avatar_url ? { login: user.login, avatarUrl: user.avatar_url } : { login: user.login };
};
var draftCommentOf = (comment) => {
  const position = Number(comment.position ?? 0);
  const original = Number(comment.original_position ?? 0);
  return {
    id: String(comment.id),
    path: comment.path,
    side: position > 0 ? "new" : "old",
    line: position > 0 ? position : original > 0 ? original : null,
    startLine: null,
    body: comment.body,
    author: personOf(comment.user)
  };
};
var createReviewDrafts = (deps) => {
  const { api, repoPath, text, integer, objectOf, selectorOf, resolveRepo, readPull, fail } = deps;
  const envelopeOf = (input) => {
    const resolved = objectOf(input, "resolved");
    const providerTarget = objectOf(resolved, "providerTarget");
    const resolvedTarget = objectOf(resolved, "target");
    return {
      kind: text(input, "kind"),
      normalized: objectOf(input, "input"),
      target: {
        owner: text(providerTarget, "owner"),
        name: text(providerTarget, "name"),
        number: integer(providerTarget, "number") || undefined,
        headSha: text(resolvedTarget, "headSha") || undefined
      }
    };
  };
  const viewerOf = (call) => {
    const login = call.session.user?.login;
    if (!login)
      throw fail("A review needs a signed-in account", 401);
    return login;
  };
  const pendingOf = async (call, repo, number, login) => {
    for (let page = 1;page <= REVIEW_SCAN_PAGES; page += 1) {
      const { data, total } = await api(call, "GET", `${repoPath(repo)}/pulls/${number}/reviews`, {
        query: { page: String(page), limit: String(REVIEW_SCAN_SIZE) }
      });
      const found = data.find((review) => review.state === "PENDING" && review.user?.login === login);
      if (found)
        return found;
      if (data.length === 0 && (total === null || page * REVIEW_SCAN_SIZE >= total))
        return null;
      if (page === 1 && data.length === total)
        return null;
    }
    throw fail(`The pull request has more reviews than this Git host scans (${REVIEW_SCAN_PAGES * REVIEW_SCAN_SIZE})`, 502, "SCAN_LIMIT");
  };
  const commentsOf = async (call, repo, number, reviewId) => (await api(call, "GET", `${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/comments`)).data;
  const requiredPending = async (call, repo, number, login) => {
    const found = await pendingOf(call, repo, number, login);
    if (!found)
      throw fail("There is no pending review on this pull request", 404);
    return found;
  };
  const reviewState = async (call, input) => {
    const { project } = await resolveRepo(call, text(input, "directory"), text(input, "remote"), selectorOf(input, "project"));
    const number = integer(input, "number");
    const login = call.session.user?.login ?? "";
    const [pull, pending] = await Promise.all([readPull(call, project, number), pendingOf(call, project, number, login)]);
    const draft = pending ? {
      id: String(pending.id),
      body: pending.body ?? "",
      comments: (await commentsOf(call, project, number, pending.id)).map(draftCommentOf)
    } : null;
    return {
      connected: true,
      viewerIsAuthor: login.length > 0 && pull.user?.login === login,
      headSha: pull.head.sha.toLowerCase(),
      draft,
      threads: [],
      truncated: false
    };
  };
  const perform = async (call, kind, normalized, providerTarget) => {
    const number = providerTarget.number ?? 0;
    const repo = repoPath(providerTarget);
    switch (kind) {
      case "change-request-review-comment": {
        viewerOf(call);
        const headSha = providerTarget.headSha;
        if (!headSha)
          throw fail("The review needs the pull request head", 400, "INVALID_SOURCE_CONTROL_MUTATION_CONTEXT");
        const position = objectOf(normalized, "position");
        const line = integer(position, "line");
        if (integer(position, "startLine")) {
          throw fail("Gitea comments on one line only; select a single line to comment on", 422);
        }
        const comment = { path: text(position, "path"), body: text(normalized, "body") };
        if (line) {
          const old = text(position, "side") === "old";
          comment.new_position = old ? 0 : line;
          comment.old_position = old ? line : 0;
        }
        await api(call, "POST", `${repo}/pulls/${number}/reviews`, {
          body: { event: "PENDING", body: DRAFT_REVIEW_BODY, commit_id: headSha, comments: [comment] }
        });
        return {};
      }
      case "change-request-review-comment-delete":
        viewerOf(call);
        throw fail("Gitea cannot remove one review comment; discard the review instead", 422);
      case "change-request-review-comment-update": {
        const login = viewerOf(call);
        const pending = await requiredPending(call, providerTarget, number, login);
        const commentId = text(normalized, "commentId");
        const comments = await commentsOf(call, providerTarget, number, pending.id);
        if (!comments.some((comment) => String(comment.id) === commentId)) {
          throw fail("The comment is not in the pending review", 409, "SOURCE_CONTROL_MUTATION_TARGET_INVALID");
        }
        await api(call, "PATCH", `${repo}/issues/comments/${encodeURIComponent(commentId)}`, { body: { body: text(normalized, "body") } });
        return {};
      }
      case "change-request-review-discard": {
        const login = viewerOf(call);
        const pending = await pendingOf(call, providerTarget, number, login);
        if (!pending)
          return {};
        await api(call, "DELETE", `${repo}/pulls/${number}/reviews/${pending.id}`);
        return {};
      }
      default:
        throw fail(`${kind} is not a review write this Git host offers`, 501, "UNSUPPORTED");
    }
  };
  const reconcile = async (call, kind, providerTarget) => {
    const number = providerTarget.number ?? 0;
    if (kind === "change-request-review-discard") {
      const login = call.session.user?.login ?? "";
      const pending = await pendingOf(call, providerTarget, number, login).catch(() => {
        return;
      });
      return pending === null ? { state: "succeeded", result: {} } : { state: "outcome-unknown" };
    }
    return { state: "outcome-unknown" };
  };
  return {
    reviewState,
    handlers: { reviewState },
    perform: (call, input) => {
      const { kind, normalized, target } = envelopeOf(input);
      return perform(call, kind, normalized, target);
    },
    reconcile: (call, input) => {
      const { kind, target } = envelopeOf(input);
      return reconcile(call, kind, target);
    }
  };
};
export {
  createReviewDrafts
};
