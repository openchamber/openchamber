// examples/source-control-provider/service/review-summaries.ts
var stateOf = (review) => {
  if (review.dismissed === true || review.state === "DISMISSED")
    return "dismissed";
  switch (review.state) {
    case "APPROVED":
      return "approved";
    case "REQUEST_CHANGES":
      return "changes_requested";
    case "COMMENT":
      return "commented";
    case "PENDING":
      return "pending";
    default:
      return null;
  }
};
var summaryOf = (review) => {
  if (!Number.isSafeInteger(review.id))
    return null;
  if (review.state === "REQUEST_REVIEW" || review.stale === true)
    return null;
  const state = stateOf(review);
  if (!state)
    return null;
  const user = review.user;
  const author = user?.login ? user.avatar_url ? { login: user.login, avatarUrl: user.avatar_url } : { login: user.login } : null;
  return { id: String(review.id), state, author, submittedAt: review.submitted_at ?? null };
};
var createReviewSummaries = ({ api, repoPath }) => ({
  read: async (call, repo, number) => {
    let reviews;
    try {
      ({ data: reviews } = await api(call, "GET", `${repoPath(repo)}/pulls/${number}/reviews`));
    } catch {
      return;
    }
    const summaries = reviews.flatMap((review) => {
      const summary = summaryOf(review);
      return summary ? [summary] : [];
    }).sort((left, right) => String(right.submittedAt ?? "").localeCompare(String(left.submittedAt ?? "")));
    return summaries.length > 0 ? summaries : undefined;
  }
});
export {
  createReviewSummaries
};
