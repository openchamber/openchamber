const MEMORY_VERSION = 1;

export const MEMORY_TITLE_MAX_LENGTH = 60;
export const MEMORY_BODY_MAX_LENGTH = 2000;

const GLOBAL_MEMORY_MAX_ITEMS = 60;
const PROJECT_MEMORY_MAX_ITEMS = 200;

const MEMORY_TYPES = new Set(['fact', 'preference', 'reference']);

import { asNonEmptyString, isRecord as isObjectRecord } from '../shared/guards.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { findThreatPattern } from './threat-patterns.js';
import { z } from 'zod';

const count = z.number().int().nonnegative().catch(0);

const dreamRecordSchema = z.object({
  finishedAt: z.number().nonnegative(),
  status: z.enum(['done', 'failed']).catch('done'),
  merged: count,
  removed: count,
  rewritten: count,
  undone: z.boolean().catch(false),
  error: z.string().min(1).transform((value) => value.slice(0, 500)).nullable().catch(null),
  toDocs: z.array(z.string().min(1)).max(200).catch([]),
});

const dreamStateSchema = z.object({
  lastRunAt: z.number().nonnegative().nullable().catch(null),
  record: dreamRecordSchema.nullable().catch(null),
  snapshot: z.array(z.unknown()).nullable().catch(null),
  after: z.array(z.object({ id: z.string().min(1), updatedAt: z.number() })).nullable().catch(null),
});

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const DUPLICATE_OVERLAP_THRESHOLD = 0.75;

const DUPLICATE_MIN_TOKENS = 4;

const RELATED_OVERLAP_THRESHOLD = 0.4;
const RELATED_LIMIT = 3;

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

const overlapFraction = (incoming, existing) => {
  if (incoming.size === 0) return 0;
  let shared = 0;
  for (const token of incoming) {
    if (existing.has(token)) shared += 1;
  }
  return shared / incoming.size;
};

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

const findRelatedEntries = (entries, title, body) => {
  const incoming = tokenize(`${title} ${body}`);
  if (incoming.size < DUPLICATE_MIN_TOKENS) return [];
  return entries
    .map((entry) => ({ entry, score: overlapFraction(incoming, tokenize(`${entry.title} ${entry.body}`)) }))
    .filter(({ score }) => score >= RELATED_OVERLAP_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    .slice(0, RELATED_LIMIT)
    .map(({ entry }) => entry);
};

const clampLength = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const bodyFitsLimit = (value) => (asNonEmptyString(value)?.length ?? 0) <= MEMORY_BODY_MAX_LENGTH;

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

  const resolveTarget = (target) => {
    if (target?.scope === 'global') {
      return { scope: 'global', key: 'global', filePath: path.join(userConfigRoot, 'memory.json') };
    }
    if (target?.scope === 'project') {
      const projectId = sanitizeProjectId(target.projectId);
      return {
        scope: 'project',
        key: `project:${projectId}`,
        filePath: path.join(projectsDirPath, projectConfigFileStemOf(projectId), 'memory.json'),
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

  const read = async (target) => {
    const resolved = resolveTarget(target);
    const stored = await readJson(resolved.filePath);

    if (!stored.missing && (!stored.value || !Array.isArray(stored.value.entries))) {
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
    if (!bodyFitsLimit(value?.body)) {
      throw new Error(`body holds at most ${MEMORY_BODY_MAX_LENGTH} characters, and this one is ${value.body.trim().length}`);
    }
    const body = clampLength(typeof value?.body === 'string' ? value.body : '', MEMORY_BODY_MAX_LENGTH).trim();
    if (!title) throw new Error('title is required');
    if (!body) throw new Error('body is required');

    return withWriteLock(resolved.key, async () => {
      const now = Date.now();
      const current = await read(target);

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
        const titles = current.entries.map((entry) => `- ${entry.title}`).join('\n');
        throw new Error(
          `${resolved.scope} memory is full (${current.entries.length}/${limit} entries). `
          + 'Consolidate before saving anything else: merge overlapping entries by rewriting one '
          + 'with its memoryId, and delete what is stale or wrong. Then retry this save, '
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
      const related = findRelatedEntries(current.entries, title, body);
      const entries = [entry, ...current.entries];
      await write(resolved, entries);
      return { entry, entries, replaced: false, related };
    });
  };

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
    if (hasBody && !bodyFitsLimit(patch.body)) {
      throw new Error(`body holds at most ${MEMORY_BODY_MAX_LENGTH} characters, and this one is ${patch.body.trim().length}`);
    }
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
      delete updated.flagged;
      if (findThreatPattern(`${updated.title}\n${updated.body}`)) updated.flagged = true;
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

  const dreamStatePath = (resolved) => path.join(path.dirname(resolved.filePath), 'memory-dream.json');

  const readDreamState = async (target) => {
    const resolved = resolveTarget(target);
    const stored = await readJson(dreamStatePath(resolved)).catch(() => ({ missing: true, value: null }));
    const parsed = dreamStateSchema.safeParse(stored.value);
    if (!parsed.success) return { lastRunAt: null, record: null, snapshot: null, after: null };
    const { lastRunAt, record, snapshot, after } = parsed.data;
    return {
      lastRunAt,
      record,
      snapshot: snapshot ? sanitizeEntries(snapshot, Date.now(), resolved.scope) : null,
      after,
    };
  };

  const writeDreamState = async (resolved, state) => {
    await writeJsonAtomic(dreamStatePath(resolved), {
      version: MEMORY_VERSION,
      lastRunAt: state.lastRunAt,
      record: state.record,
      snapshot: state.snapshot,
      after: state.after,
    });
  };

  const recordDream = async (target, { lastRunAt, record, snapshot, after = null }) => {
    const resolved = resolveTarget(target);
    return withWriteLock(resolved.key, async () => {
      const state = {
        lastRunAt,
        record: dreamRecordSchema.nullable().catch(null).parse(record ?? null),
        snapshot: Array.isArray(snapshot) ? snapshot : null,
        after: Array.isArray(snapshot) && Array.isArray(after) ? after : null,
      };
      await writeDreamState(resolved, state);
      return state;
    });
  };

  const undoDream = async (target) => {
    const resolved = resolveTarget(target);
    return withWriteLock(resolved.key, async () => {
      const state = await readDreamState(target);
      if (!state.record || state.record.undone || !state.snapshot || !state.after) return null;
      const current = await read(target);
      const leftByPass = new Map(state.after.map((item) => [item.id, item.updatedAt]));
      const beforeById = new Map(state.snapshot.map((entry) => [entry.id, entry]));
      const currentIds = new Set(current.entries.map((entry) => entry.id));
      const entries = current.entries.map((entry) => {
        const before = beforeById.get(entry.id);
        const passVersion = leftByPass.get(entry.id);
        const rewrittenByPass = before && passVersion !== undefined && passVersion !== before.updatedAt;
        return rewrittenByPass && entry.updatedAt === passVersion ? before : entry;
      });
      for (const before of state.snapshot) {
        if (!leftByPass.has(before.id) && !currentIds.has(before.id)) entries.push(before);
      }
      const restored = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limitForScope(resolved.scope));
      await write(resolved, restored);
      const record = { ...state.record, undone: true };
      await writeDreamState(resolved, { lastRunAt: state.lastRunAt, record, snapshot: null, after: null });
      return { entries: restored, record };
    });
  };

  return { read, readAll, create, update, remove, resolveTarget, readDreamState, recordDream, undoDream };
};
