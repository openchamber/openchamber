// packages/sdk/examples/source-control-provider/service/reviewer-states.ts
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
  withReviewerStates
};
