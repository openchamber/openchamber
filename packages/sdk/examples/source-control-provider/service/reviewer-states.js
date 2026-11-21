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
    if (data.length < limit || total !== null && reviews.length >= total)
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
var withReviewerStates = (context, reviews, requested) => {
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
  return latest.size === 0 ? context : { ...context, reviewerStates: [...latest.values()] };
};
export {
  readReviews,
  withReviewerStates
};
