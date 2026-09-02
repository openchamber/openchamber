/**
 * Branch-name and branch-ref helpers shared by the PR-resolution
 * logic. Mirrors the small slice of behaviour the web server and VS
 * Code extension host used to ship as private helpers (`cleanBranchName`
 * + the branch-segment extraction inside `parseRemoteBranchRef`).
 *
 * The runtime consumers still keep their own copies for non-PR
 * callers; this is the focused subset the shared core needs.
 */

/**
 * Strip common ref prefixes from a branch name.
 *
 * - `refs/heads/foo` → `foo`
 * - `heads/foo`      → `foo`
 * - `refs/foo`       → `foo`
 * - `foo`            → `foo`
 */
export const cleanBranchName = (branch: string): string => {
  if (!branch) {
    return branch;
  }
  if (branch.startsWith('refs/heads/')) {
    return branch.substring('refs/heads/'.length);
  }
  if (branch.startsWith('heads/')) {
    return branch.substring('heads/'.length);
  }
  if (branch.startsWith('refs/')) {
    return branch.substring('refs/'.length);
  }
  return branch;
};

/**
 * Extract the branch segment from a ref-string the way the consumers
 * did before extraction. Handles four forms:
 *
 *   - `<remote>/<branch>`              → `<branch>`
 *   - `remotes/<remote>/<branch>`      → `<branch>`
 *   - `refs/remotes/<remote>/<branch>` → `<branch>`
 *   - `refs/heads/<branch>`            → `<branch>`
 *
 * Returns `null` when the input is empty or has no `<branch>` segment.
 *
 * Note: a bare `refs/<other>` prefix (e.g. `refs/tags/v1.0`) is NOT
 * handled here — it falls through to the bare `<remote>/<branch>`
 * branch of the parser, matching the original behaviour where
 * `parseRemoteBranchRef` did not special-case non-`heads` refs.
 */
export const parseBranchSegment = (value: string): string | null => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (candidate.startsWith('refs/remotes/')) {
    candidate = candidate.substring('refs/remotes/'.length);
  } else if (candidate.startsWith('remotes/')) {
    candidate = candidate.substring('remotes/'.length);
  } else if (candidate.startsWith('refs/heads/')) {
    // `refs/heads/<branch>` — strip the full prefix so the branch
    // segment is the remainder. We intentionally do NOT strip the
    // bare `refs/` prefix (e.g. `refs/tags/v1.0`) — that would
    // diverge from the original `parseRemoteBranchRef` behaviour
    // where those inputs were treated as bare `<remote>/<branch>`.
    candidate = candidate.substring('refs/heads/'.length);
    if (!candidate) {
      return null;
    }
    return candidate;
  }

  const slashIndex = candidate.indexOf('/');
  if (slashIndex <= 0 || slashIndex === candidate.length - 1) {
    return null;
  }
  return candidate.slice(slashIndex + 1);
};
