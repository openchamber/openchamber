/**
 * Agent memory storage.
 *
 * What the agent has learned and chose to keep, in two scopes:
 *
 * - **project** — `<projectsDir>/<projectId>/memory.json`. How this codebase
 *   works, what was decided, where things live.
 * - **global** — `<userConfigRoot>/memory.json`. Who the user is and how they
 *   want to be worked with. It belongs to no project, so it cannot live under
 *   one.
 *
 * The split is not cosmetic. A wrong project fact costs one project and is
 * noticed quickly; a wrong global fact quietly shapes every session in every
 * project, and the user has no code to check it against. Global memory is
 * therefore deliberately narrower: fewer entries, and only the types that
 * genuinely have no other home.
 *
 * This is NOT the notes surface. Notes are what the user writes for themselves
 * and hands to the agent by pinning; memory is what the agent writes for
 * itself. Keeping them apart keeps an agent mistake out of the user's notes.
 *
 * Because the agent writes here unprompted, two invariants guard the store:
 *
 * - **Restatements replace.** A memory the agent phrases differently the second
 *   time supersedes the first rather than sitting beside it, so the store
 *   cannot fill with variants of one fact that later disagree.
 * - **Timestamps are the record of change.** The panel derives "new" and
 *   "changed" from `createdAt` and `updatedAt` against when the user last
 *   looked, so what the agent stored without asking stays visible without the
 *   store carrying any review state of its own.
 */

const MEMORY_VERSION = 1;

/**
 * Titles are what every session carries, so their combined length is the
 * standing cost of memory. Short enough to keep a full store's index modest,
 * long enough to say what an entry is about.
 */
const MEMORY_TITLE_MAX_LENGTH = 60;
const MEMORY_BODY_MAX_LENGTH = 2000;

/** Global memory stays small on purpose: it is the highest-blast-radius store. */
const GLOBAL_MEMORY_MAX_ITEMS = 60;
const PROJECT_MEMORY_MAX_ITEMS = 200;

/**
 * `fact` — something true about the project or the user.
 * `preference` — how the user wants work done.
 * `reference` — a pointer to a resource that is hard to rediscover.
 */
const MEMORY_TYPES = new Set(['fact', 'preference', 'reference']);

import { findThreatPattern } from './threat-patterns.js';

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

/**
 * Two entries are the same memory when this much of the incoming one is already
 * in the stored one. Set high on purpose: merging two genuinely different
 * memories destroys one of them silently, which is far worse than keeping a
 * near-duplicate the user can see and delete.
 */
const DUPLICATE_OVERLAP_THRESHOLD = 0.75;

/**
 * Below this many meaningful words, overlap is noise — "use bun" and "use npm"
 * share half their tokens. Short entries fall back to exact-title matching.
 */
const DUPLICATE_MIN_TOKENS = 4;

/**
 * Words carried by almost every sentence, so their overlap says nothing about
 * whether two memories mean the same thing.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that',
  'the', 'their', 'them', 'they', 'this', 'to', 'was', 'were', 'when', 'with',
]);

const tokenize = (value) => {
  const tokens = new Set();
  for (const raw of String(value).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
};

/** How much of `incoming` is already present in `existing`, in `[0, 1]`. */
const overlapFraction = (incoming, existing) => {
  if (incoming.size === 0) return 0;
  let shared = 0;
  for (const token of incoming) {
    if (existing.has(token)) shared += 1;
  }
  return shared / incoming.size;
};

/**
 * The stored entry a new one should replace, or null for a genuinely new
 * memory.
 *
 * Exact title match alone is not enough: an agent that re-learns the same fact
 * phrases it differently each time ("run UI tests per file" / "UI tests must be
 * run one file at a time"), and storing both leaves the two free to drift apart
 * until they contradict each other. Comparing the wording catches the restated
 * duplicate that the title check misses.
 */
const findSupersededEntry = (entries, title, body) => {
  const lowerTitle = title.toLowerCase();
  const exact = entries.find((entry) => entry.title.toLowerCase() === lowerTitle);
  if (exact) return exact;

  const incoming = tokenize(`${title} ${body}`);
  if (incoming.size < DUPLICATE_MIN_TOKENS) return null;

  let best = null;
  let bestScore = 0;
  for (const entry of entries) {
    const score = overlapFraction(incoming, tokenize(`${entry.title} ${entry.body}`));
    if (score >= DUPLICATE_OVERLAP_THRESHOLD && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
};

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clampLength = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const limitForScope = (scope) => (scope === 'global' ? GLOBAL_MEMORY_MAX_ITEMS : PROJECT_MEMORY_MAX_ITEMS);

const sanitizeEntries = (value, now, scope) => {
  if (!Array.isArray(value)) return [];

  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (result.length >= limitForScope(scope)) break;
    if (!isObjectRecord(entry)) continue;

    const id = asNonEmptyString(entry.id);
    const title = clampLength(asNonEmptyString(entry.title) || '', MEMORY_TITLE_MAX_LENGTH);
    const body = clampLength(typeof entry.body === 'string' ? entry.body : '', MEMORY_BODY_MAX_LENGTH).trim();
    if (!id || !title || !body || seen.has(id)) continue;
    seen.add(id);

    const createdAt = Number.isFinite(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : now;
    const sessionId = asNonEmptyString(entry.sessionId);
    result.push({
      id,
      title,
      body,
      type: MEMORY_TYPES.has(entry.type) ? entry.type : 'fact',
      createdAt,
      updatedAt: Number.isFinite(entry.updatedAt) && entry.updatedAt >= 0 ? entry.updatedAt : createdAt,
      // Re-checked on every read, not trusted from the file: an entry written
      // before a pattern existed, or edited on disk since, is judged now.
      ...(findThreatPattern(`${title}\n${body}`) ? { flagged: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }

  return result.sort((a, b) => b.updatedAt - a.updatedAt);
};

const createEmptyMemory = () => ({ version: MEMORY_VERSION, entries: [] });

export const createAgentMemoryRuntime = (deps) => {
  const { fsPromises, path, projectsDirPath, userConfigRoot, createId } = deps;

  const idFactory = typeof createId === 'function'
    ? createId
    : () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

  const writeLocks = new Map();

  const sanitizeProjectId = (projectId) => {
    const value = asNonEmptyString(projectId);
    if (!value) {
      throw new Error('projectId is required');
    }
    if (!PROJECT_ID_PATTERN.test(value)) {
      throw new Error('projectId contains unsupported characters');
    }
    return value;
  };

  /** `target` is `{ scope: 'global' }` or `{ scope: 'project', projectId }`. */
  const resolveTarget = (target) => {
    if (target?.scope === 'global') {
      return { scope: 'global', key: 'global', filePath: path.join(userConfigRoot, 'memory.json') };
    }
    if (target?.scope === 'project') {
      const projectId = sanitizeProjectId(target.projectId);
      return {
        scope: 'project',
        key: `project:${projectId}`,
        filePath: path.join(projectsDirPath, projectId, 'memory.json'),
      };
    }
    throw new Error('scope is required');
  };

  const readJson = async (filePath) => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { missing: true, value: null };
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      return { missing: false, value: isObjectRecord(parsed) ? parsed : null };
    } catch {
      return { missing: false, value: null };
    }
  };

  const writeJsonAtomic = async (filePath, value) => {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const withWriteLock = async (key, mutate) => {
    const previous = writeLocks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const chained = previous.finally(() => next);
    writeLocks.set(key, chained);

    await previous;
    try {
      return await mutate();
    } finally {
      release();
      if (writeLocks.get(key) === chained) {
        writeLocks.delete(key);
      }
    }
  };

  /**
   * Missing is authoritative empty; malformed is a failure. An agent that reads
   * "no memory" from a corrupt file would cheerfully rewrite everything it
   * thought it had lost.
   */
  const read = async (target) => {
    const resolved = resolveTarget(target);
    const stored = await readJson(resolved.filePath);

    if (!stored.missing && !stored.value) {
      throw new Error('Stored agent memory is malformed');
    }
    if (stored.missing) {
      return createEmptyMemory();
    }

    return {
      version: MEMORY_VERSION,
      entries: sanitizeEntries(stored.value.entries, Date.now(), resolved.scope),
    };
  };

  const write = async (resolved, entries) => {
    await writeJsonAtomic(resolved.filePath, { version: MEMORY_VERSION, entries });
  };

  const create = async (target, value) => {
    const resolved = resolveTarget(target);
    const title = clampLength(asNonEmptyString(value?.title) || '', MEMORY_TITLE_MAX_LENGTH);
    const body = clampLength(typeof value?.body === 'string' ? value.body : '', MEMORY_BODY_MAX_LENGTH).trim();
    if (!title) throw new Error('title is required');
    if (!body) throw new Error('body is required');

    return withWriteLock(resolved.key, async () => {
      const now = Date.now();
      const current = await read(target);

      // A restatement of something already stored is an update, not a second
      // copy: an agent re-learning a fact each session would otherwise fill the
      // store with near-duplicates and contradict itself.
      //
      // Checked before the capacity limit, because replacing an entry does not
      // grow the store — a full store must still be able to correct itself.
      const existing = findSupersededEntry(current.entries, title, body);
      if (existing) {
        const updated = {
          ...existing,
          title,
          body,
          updatedAt: now,
          ...(MEMORY_TYPES.has(value?.type) ? { type: value.type } : {}),
        };
        const entries = current.entries.map((entry) => (entry.id === existing.id ? updated : entry));
        await write(resolved, entries);
        return { entry: updated, entries, replaced: true };
      }

      const limit = limitForScope(resolved.scope);
      if (current.entries.length >= limit) {
        // Handed its own titles and told what to do with them. A bare "full"
        // leaves the agent with a dead end, when the useful move — merge the
        // overlapping entries, drop the stale ones, then retry — is something
        // only it can judge.
        const titles = current.entries.map((entry) => `- ${entry.title}`).join('\n');
        throw new Error(
          `${resolved.scope} memory is full (${current.entries.length}/${limit} entries). `
          + 'Consolidate before saving anything else: merge overlapping entries by saving one '
          + 'under an existing title, and delete what is stale or wrong. Then retry this save, '
          + `all in this turn. Current entries:\n${titles}`,
        );
      }

      const sessionId = asNonEmptyString(value?.sessionId);
      const entry = {
        id: idFactory(),
        title,
        body,
        type: MEMORY_TYPES.has(value?.type) ? value.type : 'fact',
        createdAt: now,
        updatedAt: now,
        ...(findThreatPattern(`${title}\n${body}`) ? { flagged: true } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
      const entries = [entry, ...current.entries];
      await write(resolved, entries);
      return { entry, entries, replaced: false };
    });
  };

  /**
   * A user correction. The agent rewrites by saving the same memory again, so
   * this exists for the panel: a memory worded badly enough to mislead should
   * be fixable where it is read, not only deletable.
   */
  const update = async (target, memoryId, patch) => {
    const resolved = resolveTarget(target);
    const id = asNonEmptyString(memoryId);
    if (!id) throw new Error('memoryId is required');

    const hasTitle = typeof patch?.title === 'string';
    const hasBody = typeof patch?.body === 'string';
    const hasType = MEMORY_TYPES.has(patch?.type);
    if (!hasTitle && !hasBody && !hasType) {
      throw new Error('title, body or type is required');
    }
    const title = hasTitle ? clampLength(patch.title, MEMORY_TITLE_MAX_LENGTH).trim() : null;
    const body = hasBody ? clampLength(patch.body, MEMORY_BODY_MAX_LENGTH).trim() : null;
    if (hasTitle && !title) throw new Error('title is required');
    if (hasBody && !body) throw new Error('body is required');

    return withWriteLock(resolved.key, async () => {
      const current = await read(target);
      const existing = current.entries.find((entry) => entry.id === id);
      if (!existing) {
        return null;
      }

      const updated = {
        ...existing,
        ...(hasTitle ? { title } : {}),
        ...(hasBody ? { body } : {}),
        ...(hasType ? { type: patch.type } : {}),
        updatedAt: Date.now(),
      };
      const entries = current.entries.map((entry) => (entry.id === id ? updated : entry));
      await write(resolved, entries);
      return { entry: updated, entries };
    });
  };

  const remove = async (target, memoryId) => {
    const resolved = resolveTarget(target);
    const id = asNonEmptyString(memoryId);
    if (!id) throw new Error('memoryId is required');

    return withWriteLock(resolved.key, async () => {
      const current = await read(target);
      if (!current.entries.some((entry) => entry.id === id)) {
        return { deleted: false, entries: current.entries };
      }
      const entries = current.entries.filter((entry) => entry.id !== id);
      await write(resolved, entries);
      return { deleted: true, entries };
    });
  };

  /**
   * Both scopes at once, for the session index. A failure in one scope must not
   * hide the other: losing the project half should not also erase what the
   * agent knows about the user.
   */
  const readAll = async (projectId) => {
    const settled = await Promise.allSettled([
      read({ scope: 'global' }),
      projectId ? read({ scope: 'project', projectId }) : Promise.resolve(createEmptyMemory()),
    ]);

    return {
      global: settled[0].status === 'fulfilled' ? settled[0].value.entries : [],
      project: settled[1].status === 'fulfilled' ? settled[1].value.entries : [],
      globalFailed: settled[0].status === 'rejected',
      projectFailed: settled[1].status === 'rejected',
    };
  };

  return { read, readAll, create, update, remove, resolveTarget };
};
