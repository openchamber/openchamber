// packages/sdk/examples/source-control-provider/service/reviewer-states.ts
var REVIEW_SCAN_PAGES = 10;
var REVIEW_BUDGET_MS = 8000;
var scanReviews = async (limit, readPage, expired) => {
  const reviews = [];
  for (let page = 1;page <= REVIEW_SCAN_PAGES; page += 1) {
    const { data, total } = await readPage(page, limit);
    if (expired() || !Array.isArray(data))
      return null;
    reviews.push(...data);
    if (data.length === 0 && (total === null || page * limit >= total))
      return reviews;
    if (page === 1 && data.length === total)
      return reviews;
  }
  return null;
};
var readReviews = async (limit, readPage, budgetMs = REVIEW_BUDGET_MS) => {
  let expired = false;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(null);
    }, budgetMs);
  });
  try {
    return await Promise.race([scanReviews(limit, readPage, () => expired), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
var STATE = new Map([
  ["APPROVED", "approved"],
  ["REQUEST_CHANGES", "changes_requested"],
  ["COMMENT", "commented"]
]);
var stateOf = (state) => STATE.get(state) ?? null;
var person = (user) => {
  const mapped = { id: String(user.id), username: user.login };
  if (user.avatar_url)
    mapped.avatarUrl = user.avatar_url;
  return mapped;
};
var SUMMARY_STATE = new Map([
  ["APPROVED", "approved"],
  ["REQUEST_CHANGES", "changes_requested"],
  ["COMMENT", "commented"],
  ["PENDING", "pending"]
]);
var reviewSummaries = (reviews) => {
  const opinions = reviews.filter((review) => review.dismissed === true || review.state !== "REQUEST_REVIEW");
  const summaries = opinions.flatMap((review) => {
    const state = review.dismissed === true ? "dismissed" : SUMMARY_STATE.get(review.state);
    if (!Number.isSafeInteger(review.id) || !state)
      return [];
    const author = review.user ? { login: review.user.login } : null;
    if (author && review.user?.avatar_url)
      author.avatarUrl = review.user.avatar_url;
    return [{ id: String(review.id), state, author, submittedAt: review.submitted_at ?? null }];
  });
  if (summaries.length === 0 && opinions.length > 0)
    return;
  return summaries.sort((left, right) => String(right.submittedAt ?? "").localeCompare(String(left.submittedAt ?? "")));
};
var DISMISS_KIND = "change-request-review-dismiss";
var reviewDismissal = (api, Refused) => {
  const reviewPath = (target, reviewId) => `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/pulls/${target.number ?? 0}/reviews/${encodeURIComponent(reviewId)}`;
  const readReview = async (call, target, reviewId) => {
    try {
      const { data } = await api(call, "GET", reviewPath(target, reviewId));
      if (String(data.id) === reviewId)
        return data;
    } catch (error) {
      if (Object(error).status !== 404)
        throw error;
    }
    throw new Refused("The review is not on this pull request", 409, "SOURCE_CONTROL_MUTATION_TARGET_INVALID");
  };
  return {
    perform: async (call, kind, input, target) => {
      if (kind !== DISMISS_KIND)
        throw new Refused(`${kind} is not something this Git host offers`, 501, "UNSUPPORTED");
      const reviewId = String(input.reviewId ?? "");
      await readReview(call, target, reviewId);
      const dismissed = input.dismissed !== false;
      const body = dismissed ? { message: String(input.message ?? "") } : {};
      await api(call, "POST", `${reviewPath(target, reviewId)}/${dismissed ? "dismissals" : "undismissals"}`, { body });
      return {};
    },
    reconcile: async (call, kind, input, target) => {
      if (kind !== DISMISS_KIND)
        return { state: "outcome-unknown" };
      const review = await readReview(call, target, String(input.reviewId ?? ""));
      return typeof review.dismissed === "boolean" && review.dismissed === (input.dismissed !== false) ? { state: "succeeded", result: {} } : { state: "outcome-unknown" };
    }
  };
};
var withReviewerStates = (context, reviews, requested, canDismissReviews) => {
  if (!reviews)
    return context;
  const latest = new Map;
  for (const review of reviews) {
    const state = review.dismissed === true ? "pending" : stateOf(review.state);
    if (review.user && state)
      latest.set(String(review.user.id), { user: person(review.user), state });
  }
  for (const user of requested) {
    if (!latest.has(String(user.id)))
      latest.set(String(user.id), { user: person(user), state: "pending" });
  }
  const summaries = reviewSummaries(reviews);
  const withReviews = summaries === undefined ? { ...context, canDismissReviews } : { ...context, reviews: summaries, canDismissReviews };
  return latest.size === 0 ? withReviews : { ...withReviews, reviewerStates: [...latest.values()] };
};
export {
  readReviews,
  reviewDismissal,
  withReviewerStates
};
