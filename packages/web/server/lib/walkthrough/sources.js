import {
  getCommitDiff,
  getDiff,
  getRangeDiff,
  getUntrackedDiffs,
  listUntrackedPaths,
} from '../git/execution-service.js';
import assert from 'node:assert/strict';

const defaultGit = Object.freeze({
  getDiff,
  getRangeDiff,
  getUntrackedDiffs,
  listUntrackedPaths,
  getCommitDiff,
});

// A walkthrough source resolves to one or more diff *sections*. A section is a
// patch plus the scope its hunk ids live in; keeping staged and working-tree
// changes in separate scopes means a stop written against staged code never
// silently re-anchors onto an unstaged edit of the same lines.

const WORKING_TREE_SCOPES = new Set(['all', 'staged', 'working']);
const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isObjectValue = (value) => Object.prototype.toString.call(value) === '[object Object]';
const FUNCTION_VALUE_TAGS = new Set([
  '[object Function]',
  '[object AsyncFunction]',
  '[object GeneratorFunction]',
  '[object AsyncGeneratorFunction]',
]);
const isFunctionValue = (value) => FUNCTION_VALUE_TAGS.has(Object.prototype.toString.call(value));

export class WalkthroughSourceError extends Error {
  constructor(message, statusCode = 400, code = undefined) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

/**
 * Normalize and validate an untrusted source descriptor from the client.
 */
export function parseSource(raw) {
  if (!raw || !isObjectValue(raw)) {
    throw new WalkthroughSourceError('source is required');
  }

  if (raw.kind === 'working-tree') {
    const scope = isStringValue(raw.scope) ? raw.scope : 'all';
    if (!WORKING_TREE_SCOPES.has(scope)) {
      throw new WalkthroughSourceError(`Unknown working-tree scope "${scope}"`);
    }
    return { kind: 'working-tree', scope };
  }

  if (raw.kind === 'branch') {
    const baseRef = isStringValue(raw.baseRef) ? raw.baseRef.trim() : '';
    const headRef = isStringValue(raw.headRef) ? raw.headRef.trim() : '';
    if (!baseRef || !headRef) {
      throw new WalkthroughSourceError('branch sources require baseRef and headRef');
    }
    return { kind: 'branch', baseRef, headRef };
  }

  if (raw.kind === 'pr') {
    const number = Number(raw.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw new WalkthroughSourceError('pr sources require a positive number');
    }
    if (raw.sourceRepo !== undefined) {
      const { owner, repo } = raw.sourceRepo ?? {};
      try {
        assert.match(owner, /^[a-zA-Z0-9-]+$/);
        assert.match(repo, /^[a-zA-Z0-9_.-]+$/);
      } catch {
        throw new WalkthroughSourceError('pr sources require a valid repository');
      }
      return { kind: 'pr', number, sourceRepo: { owner, repo } };
    }
    return { kind: 'pr', number };
  }

  if (raw.kind === 'commit') {
    // Sources are content-addressed: accept a full object id, never a moving ref.
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(raw.hash)) {
      throw new WalkthroughSourceError('commit sources require a full commit hash');
    }
    try {
      return { kind: 'commit', hash: raw.hash.toLowerCase() };
    } catch {
      throw new WalkthroughSourceError('commit sources require a full commit hash');
    }
  }

  throw new WalkthroughSourceError(`Unknown source kind "${String(raw.kind)}"`);
}

/**
 * Stable string form of a source, used as the pointer key and as part of the
 * cache key. Must not change shape casually — it addresses persisted files.
 */
export function sourceKey(source) {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  if (source.kind === 'commit') return `commit:${source.hash}`;
  return source.sourceRepo ? `pr:${source.sourceRepo.owner}/${source.sourceRepo.repo}:${source.number}` : `pr:${source.number}`;
}

// `git diff` never reports untracked files, so a brand-new file would be
// invisible in a walkthrough of local work. The batch helper resolves the
// repository once and bounds how many diff processes run at a time.
const untrackedSections = async (directory, git, signal) => {
  const readOptions = signal ? { signal } : {};
  const untracked = await git.listUntrackedPaths(directory, readOptions);
  if (untracked.length === 0) return [];

  const patches = await git.getUntrackedDiffs(directory, untracked, readOptions);
  return patches.filter((patch) => isStringValue(patch) && patch.trim());
};

/**
 * Resolve a source into diff sections.
 *
 * @returns {Promise<{sections: Array<{scope: string, patch: string}>, meta: object}>}
 */
export async function loadSourceSections(
  directory,
  source,
  { getPullRequestDiff, git = defaultGit, signal } = {},
) {
  const readOptions = signal ? { signal } : {};
  if (source.kind === 'working-tree') {
    const sections = [];

    if (source.scope === 'all' || source.scope === 'staged') {
      const patch = await git.getDiff(directory, { staged: true, ...readOptions });
      if (patch && patch.trim()) sections.push({ scope: 'staged', patch });
    }

    if (source.scope === 'all' || source.scope === 'working') {
      const patch = await git.getDiff(directory, { staged: false, ...readOptions });
      const untracked = await untrackedSections(directory, git, signal);
      const combined = [patch, ...untracked].filter((value) => value && value.trim()).join('\n');
      if (combined.trim()) sections.push({ scope: 'working', patch: combined });
    }

    return { sections, meta: {} };
  }

  if (source.kind === 'branch') {
    const patch = await git.getRangeDiff(directory, {
      base: source.baseRef,
      head: source.headRef,
      includeWorkingTree: true,
      ...readOptions,
    });
    return {
      sections: patch && patch.trim() ? [{ scope: 'branch', patch }] : [],
      meta: { baseRef: source.baseRef, headRef: source.headRef },
    };
  }

  if (source.kind === 'commit') {
    const commitOptions = { hash: source.hash };
    if (signal) commitOptions.signal = signal;
    const patch = await git.getCommitDiff(directory, commitOptions);
    return {
      sections: patch.trim() ? [{ scope: 'commit', patch }] : [],
      meta: { hash: source.hash },
    };
  }

  if (!isFunctionValue(getPullRequestDiff)) {
    throw new WalkthroughSourceError('Pull request diffs are unavailable', 500);
  }

  const result = signal
    ? await getPullRequestDiff(directory, source.number, source.sourceRepo, { signal })
    : await getPullRequestDiff(directory, source.number, source.sourceRepo);
  const { patch, meta } = result;
  return {
    sections: patch && patch.trim() ? [{ scope: `pr:${source.number}`, patch }] : [],
    meta: meta || {},
  };
}
