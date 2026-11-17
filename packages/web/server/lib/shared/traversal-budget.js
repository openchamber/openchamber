// One traversal budget for recursive directory walks over trees the
// server does not control (design #1391 phase 1, #1392).
//
// Three capped walks on main used to spell this judgement three ways:
// fs/search.js read its BFS `visited` Set's own size as the cap test,
// fs/routes.js findGitDirectories threaded a (maxDepth, maxDirs)
// parameter pair, and opencode/agents.js carried both a per-root local
// counter and a threaded `{ visitedDirs }` object against one constant.
// The uncapped walks (#1357, #1365, #1366) had no spelling at all. This
// module is the shared counting core the #1391 contract names:
//
// 1. Every recursive walk over an uncontrolled tree carries a named
//    budget; the values stay per-walk and are stated at the walk.
// 2. The budget counts what the walk consumes, not what it returns —
//    directories visited is the mandatory dimension (#1332's files-only
//    counter was vacuous on a directory-only tree). Entries seen and
//    depth are optional dimensions; a deadline is an optional dimension
//    for async walks only (a sync walk never yields to check one, so
//    counts are its honest bound).
// 3. One budget object, one spelling: the walk consults the budget
//    BEFORE descending into a directory, the consultation counts the
//    directory when it is allowed, and the walk reads `truncated`
//    afterwards. A followed link's directories count against the same
//    budget as the root's — the budget is consulted per directory
//    entered, however the walk reached it — so no link can expand a
//    walk past its budget. Link policy itself stays per-walk.
// 4. Two dispositions at the bound, chosen by what the walk produces
//    (recorded in DOCUMENTATION.md): enumerate = stop, return what was
//    found, signal the truncation; copy = abort, leave no partial
//    destination. This module supplies the counting and the signal;
//    the disposition stays with the caller.
//
// The budget knows counts and a clock only — no paths, no fs surface,
// nothing domain-specific (the lib/shared admission rule).

const requirePositiveInt = (name, value) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`createTraversalBudget: ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
};

const optionalPositiveInt = (name, value) => (value === undefined ? null : requirePositiveInt(name, value));

/**
 * Create the one budget object a directory walk consults.
 *
 * `maxDirs` is mandatory. `maxEntries`, `maxDepth` and `deadlineMs` are
 * optional dimensions; an omitted dimension is unbounded. `deadlineMs`
 * is measured from creation on the wall clock and is consulted by the
 * async walks; sync callers pass counts alone.
 *
 * Consult `visitDir()` before descending into a directory (the root
 * included, if the walk counts it): it answers whether the directory
 * may be entered and counts it when it may. Pass the directory's depth
 * (1 for the root) when the budget carries `maxDepth`; a directory past
 * the depth bound is refused without consuming the directory count and
 * without stopping shallower consultations. Consult `visitEntry()` for
 * each entry the walk counts under `maxEntries`.
 *
 * A refused consultation sets `truncated` and never moves a counter:
 * repeated consultation after exhaustion keeps answering "stop" with
 * no drift past the bound. A walk that consumes exactly its bound and
 * never consults again finishes with `truncated` unset.
 */
export const createTraversalBudget = (options = {}) => {
  const { maxDirs, maxEntries, maxDepth, deadlineMs } = options ?? {};
  const dirsLimit = requirePositiveInt('maxDirs', maxDirs);
  const entriesLimit = optionalPositiveInt('maxEntries', maxEntries);
  const depthLimit = optionalPositiveInt('maxDepth', maxDepth);
  const deadlineAt = deadlineMs === undefined ? null : Date.now() + requirePositiveInt('deadlineMs', deadlineMs);

  let visitedDirs = 0;
  let visitedEntries = 0;
  let dirsStopped = false;
  let entriesStopped = false;
  let truncatedFlag = false;

  const deadlinePassed = () => deadlineAt !== null && Date.now() >= deadlineAt;

  const visitDir = (depth) => {
    if (dirsStopped || deadlinePassed()) {
      dirsStopped = true;
      truncatedFlag = true;
      return false;
    }
    if (depthLimit !== null && depth !== undefined) {
      if (!Number.isSafeInteger(depth) || depth < 1) {
        throw new RangeError(`traversalBudget.visitDir: depth must be a positive integer, got ${String(depth)}`);
      }
      if (depth > depthLimit) {
        // A branch-local refusal: this subtree is cut (so the walk was
        // truncated), but the directory is not counted and shallower
        // directories may still be entered.
        truncatedFlag = true;
        return false;
      }
    }
    if (visitedDirs >= dirsLimit) {
      dirsStopped = true;
      truncatedFlag = true;
      return false;
    }
    visitedDirs += 1;
    return true;
  };

  const visitEntry = () => {
    if (entriesStopped || deadlinePassed()) {
      entriesStopped = true;
      truncatedFlag = true;
      return false;
    }
    if (entriesLimit !== null && visitedEntries >= entriesLimit) {
      entriesStopped = true;
      truncatedFlag = true;
      return false;
    }
    visitedEntries += 1;
    return true;
  };

  return {
    visitDir,
    visitEntry,
    get visitedDirs() {
      return visitedDirs;
    },
    get visitedEntries() {
      return visitedEntries;
    },
    get exhausted() {
      return dirsStopped || entriesStopped || deadlinePassed();
    },
    get truncated() {
      return truncatedFlag;
    },
    maxDirs: dirsLimit,
    maxEntries: entriesLimit,
    maxDepth: depthLimit,
  };
};
