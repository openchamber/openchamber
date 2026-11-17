import { getDiff, getRangeDiff, getCommitDiff, getUntrackedDiffs, listUntrackedPaths } from '../git/service.js';
import assert from 'node:assert/strict';
import { isString } from '../shared/guards.js';
import { joinProjectPath } from '../source-control/project-path.js';

const WORKING_TREE_SCOPES = new Set(['all', 'staged', 'working']);

export class WalkthroughSourceError extends Error {
  constructor(message, statusCode = 400, code = undefined) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

export function parseSource(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new WalkthroughSourceError('source is required');
  }

  if (raw.kind === 'working-tree') {
    const scope = typeof raw.scope === 'string' ? raw.scope : 'all';
    if (!WORKING_TREE_SCOPES.has(scope)) {
      throw new WalkthroughSourceError(`Unknown working-tree scope "${scope}"`);
    }
    return { kind: 'working-tree', scope };
  }

  if (raw.kind === 'branch') {
    const baseRef = typeof raw.baseRef === 'string' ? raw.baseRef.trim() : '';
    const headRef = typeof raw.headRef === 'string' ? raw.headRef.trim() : '';
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
    let revision;
    if (raw.revision !== undefined) {
      if (!isString(raw.revision) || !/^[0-9a-f]{40}$/i.test(raw.revision)) {
        throw new WalkthroughSourceError('pr sources require a full revision SHA');
      }
      revision = raw.revision.toLowerCase();
    }
    const withRevision = (source) => {
      if (revision) source.revision = revision;
      if (raw.linked === true) source.linked = true;
      return source;
    };
    if (raw.sourceRepo !== undefined) {
      const { owner, repo } = raw.sourceRepo ?? {};
      try {
        if (owner !== '') assert.match(owner, /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?:\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)*$/);
        assert.match(repo, /^[a-zA-Z0-9_.-]+$/);
      } catch {
        throw new WalkthroughSourceError('pr sources require a valid repository');
      }
      return withRevision({ kind: 'pr', number, sourceRepo: { owner, repo } });
    }
    return withRevision({ kind: 'pr', number });
  }

  if (raw.kind === 'commit') {
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

export function sourceKey(source) {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  if (source.kind === 'commit') return `commit:${source.hash}`;
  const pr = source.sourceRepo ? `pr:${joinProjectPath(source.sourceRepo.owner, source.sourceRepo.repo)}:${source.number}` : `pr:${source.number}`;
  return source.revision ? `${pr}@${source.revision}` : pr;
}

const untrackedSections = async (directory) => {
  const untracked = await listUntrackedPaths(directory);
  if (untracked.length === 0) return [];

  const patches = await getUntrackedDiffs(directory, untracked);
  return patches.filter((patch) => typeof patch === 'string' && patch.trim());
};

/**
 * Resolve a source into diff sections.
 *
 * @returns {Promise<{sections: Array<{scope: string, patch: string}>, meta: object}>}
 */
export async function loadSourceSections(directory, source, { getPullRequestDiff, readContext } = {}) {
  if (source.kind === 'working-tree') {
    const sections = [];

    if (source.scope === 'all' || source.scope === 'staged') {
      const patch = await getDiff(directory, { staged: true });
      if (patch && patch.trim()) sections.push({ scope: 'staged', patch });
    }

    if (source.scope === 'all' || source.scope === 'working') {
      const patch = await getDiff(directory, { staged: false });
      const untracked = await untrackedSections(directory);
      const combined = [patch, ...untracked].filter((value) => value && value.trim()).join('\n');
      if (combined.trim()) sections.push({ scope: 'working', patch: combined });
    }

    return { sections, meta: {} };
  }

  if (source.kind === 'branch') {
    const patch = await getRangeDiff(directory, { base: source.baseRef, head: source.headRef, includeWorkingTree: true });
    return {
      sections: patch && patch.trim() ? [{ scope: 'branch', patch }] : [],
      meta: { baseRef: source.baseRef, headRef: source.headRef },
    };
  }

  if (source.kind === 'commit') {
    const patch = await getCommitDiff(directory, { hash: source.hash });
    return {
      sections: patch.trim() ? [{ scope: 'commit', patch }] : [],
      meta: { hash: source.hash },
    };
  }

  if (typeof getPullRequestDiff !== 'function') {
    throw new WalkthroughSourceError('Pull request diffs are unavailable', 500);
  }

  const options = { sourceRepo: source.sourceRepo ?? null };
  if (source.revision) options.revision = source.revision;
  const { patch, meta } = await getPullRequestDiff(directory, source.number, readContext, options);
  return {
    sections: patch && patch.trim() ? [{ scope: `pr:${source.number}`, patch }] : [],
    meta: meta || {},
  };
}
