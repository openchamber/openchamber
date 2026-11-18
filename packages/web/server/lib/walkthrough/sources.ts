import { getDiff, getRangeDiff, getCommitDiff, getUntrackedDiffs, listUntrackedPaths } from '../git/service.js';
import assert from 'node:assert/strict';
import { isString } from '../shared/guards.js';
import { joinProjectPath } from '../source-control/project-path.js';
import type { WalkthroughSource, ReadContext } from './contracts.js';
import type { DiffSection } from './digest.js';
import type { WalkthroughRouteService } from './routes.js';

interface SourceInput {
  kind?: unknown;
  scope?: unknown;
  baseRef?: unknown;
  headRef?: unknown;
  number?: unknown;
  revision?: unknown;
  linked?: unknown;
  sourceRepo?: unknown;
  hash?: unknown;
}

export interface SourceRequest {
  source?: unknown;
}

interface SourceDependencies {
  getPullRequestDiff?: WalkthroughRouteService['getPullRequestDiff'] | undefined;
  readContext?: ReadContext | undefined;
}

const isSourceInput = (value: unknown): value is SourceInput => Boolean(value) && typeof value === 'object';
const hasRepositoryFields = (value: unknown): value is { owner?: unknown; repo?: unknown } => value !== null && value !== undefined;
const hasLowercaseField = (value: unknown): value is { toLowerCase?: unknown } => value !== null && value !== undefined;
const isLowercaseMethod = (value: unknown): value is () => SourceInput['hash'] => typeof value === 'function';
const isSymbol = (value: unknown): value is symbol => typeof value === 'symbol';
const hashText = (hash: SourceInput['hash']) => {
  if (isSymbol(hash)) throw new TypeError('Cannot convert a Symbol value to a string');
  return String(hash);
};
const isWorkingTreeScope = (value: string): value is Extract<WalkthroughSource, { kind: 'working-tree' }>['scope'] => WORKING_TREE_SCOPES.has(value);

const WORKING_TREE_SCOPES = new Set(['all', 'staged', 'working']);

export class WalkthroughSourceError extends Error {
  declare statusCode: number;
  declare code?: string;

  constructor(message: string, statusCode = 400, code: string | undefined = undefined) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

export function parseSource(raw: SourceRequest['source']): WalkthroughSource {
  if (!isSourceInput(raw)) {
    throw new WalkthroughSourceError('source is required');
  }

  if (raw.kind === 'working-tree') {
    const scope = isString(raw.scope) ? raw.scope : 'all';
    if (!isWorkingTreeScope(scope)) {
      throw new WalkthroughSourceError(`Unknown working-tree scope "${scope}"`);
    }
    return { kind: 'working-tree', scope };
  }

  if (raw.kind === 'branch') {
    const baseRef = isString(raw.baseRef) ? raw.baseRef.trim() : '';
    const headRef = isString(raw.headRef) ? raw.headRef.trim() : '';
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
    let revision: string | undefined;
    if (raw.revision !== undefined) {
      if (!isString(raw.revision) || !/^[0-9a-f]{40}$/i.test(raw.revision)) {
        throw new WalkthroughSourceError('pr sources require a full revision SHA');
      }
      revision = raw.revision.toLowerCase();
    }
    const withRevision = (source: Extract<WalkthroughSource, { kind: 'pr' }>) => {
      if (revision) source.revision = revision;
      if (raw.linked === true) source.linked = true;
      return source;
    };
    if (raw.sourceRepo !== undefined) {
      const { owner, repo } = hasRepositoryFields(raw.sourceRepo) ? raw.sourceRepo : {};
      try {
        assert(isString(owner));
        assert(isString(repo));
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
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hashText(raw.hash))) {
      throw new WalkthroughSourceError('commit sources require a full commit hash');
    }
    try {
      const hash = raw.hash;
      if (!hasLowercaseField(hash)) throw new WalkthroughSourceError('commit sources require a full commit hash');
      const lowercase = hash.toLowerCase;
      if (!isLowercaseMethod(lowercase)) throw new WalkthroughSourceError('commit sources require a full commit hash');
      const normalized: SourceInput['hash'] = Function.prototype.call.call(lowercase, hash);
      return { kind: 'commit', hash: normalized };
    } catch {
      throw new WalkthroughSourceError('commit sources require a full commit hash');
    }
  }

  throw new WalkthroughSourceError(`Unknown source kind "${String(raw.kind)}"`);
}

export function sourceKey(source: WalkthroughSource) {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  if (source.kind === 'commit') return `commit:${source.hash}`;
  const pr = source.sourceRepo ? `pr:${joinProjectPath(source.sourceRepo.owner, source.sourceRepo.repo)}:${source.number}` : `pr:${source.number}`;
  return source.revision ? `${pr}@${source.revision}` : pr;
}

const untrackedSections = async (directory: string) => {
  const untracked = await listUntrackedPaths(directory);
  if (untracked.length === 0) return [];

  const patches = await getUntrackedDiffs(directory, untracked);
  return patches.filter((patch) => patch.trim());
};

export async function loadSourceSections(directory: string, source: WalkthroughSource, { getPullRequestDiff, readContext }: SourceDependencies = {}) {
  if (source.kind === 'working-tree') {
    const sections: DiffSection[] = [];

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

  if (!isPullRequestReader(getPullRequestDiff)) {
    throw new WalkthroughSourceError('Pull request diffs are unavailable', 500);
  }

  const options: Parameters<WalkthroughRouteService['getPullRequestDiff']>[3] = { sourceRepo: source.sourceRepo ?? null };
  if (source.revision) options.revision = source.revision;
  const { patch, meta } = await getPullRequestDiff(directory, source.number, readContext, options);
  if (patch && !isString(patch)) throw new TypeError('patch.trim is not a function');
  return {
    sections: patch && isString(patch) && patch.trim() ? [{ scope: `pr:${source.number}`, patch }] : [],
    meta: meta || {},
  };
}

const isPullRequestReader = (value: unknown): value is WalkthroughRouteService['getPullRequestDiff'] => typeof value === 'function';
