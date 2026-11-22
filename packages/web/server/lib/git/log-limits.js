// The largest UI history page is 100 commits. Keep 100x headroom while
// bounding Git output and the entry array built from it.
export const MAX_GIT_LOG_COUNT = 10_000;
