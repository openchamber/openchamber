const MEMORY_VERSION = 1;

export const MEMORY_TITLE_MAX_LENGTH = 60;
export const MEMORY_BODY_MAX_LENGTH = 2000;

const GLOBAL_MEMORY_MAX_ITEMS = 60;
const PROJECT_MEMORY_MAX_ITEMS = 200;

import { asNonEmptyString } from '../shared/guards.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { findThreatPattern } from './threat-patterns.js';
import { z } from 'zod';
import { isMemoryRecord, isMemoryText, isMemoryTimestamp, isMemoryType } from './contracts.js';
import type { MemoryDocument, MemoryEntry, MemoryScope, MemoryTarget, MemoryWriteInput } from './contracts.js';

interface MemoryRuntimeDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'mkdir' | 'writeFile' | 'rename' | 'rm'>;
  path: Pick<typeof import('node:path'), 'join' | 'dirname'>;
  projectsDirPath: string;
  userConfigRoot: string;
  createId?: () => string;
}

interface ResolvedMemoryTarget {
  scope: MemoryScope;
  key: string;
  filePath: string;
}

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

export type DreamRecord = z.infer<typeof dreamRecordSchema>;
export type DreamState = Omit<z.infer<typeof dreamStateSchema>, 'snapshot'> & { snapshot: MemoryEntry[] | null };

interface DreamWriteInput {
  lastRunAt: number | null;
  record: unknown;
  snapshot: unknown;
  after?: unknown;
}

interface StoredDreamState {
  lastRunAt: number | null;
  record: DreamRecord | null;
  snapshot: unknown[] | null;
  after: unknown[] | null;
}

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

const tokenize = (value: string) => {
  const tokens = new Set<string>();
  for (const raw of String(value).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
};

const overlapFraction = (incoming: Set<string>, existing: Set<string>) => {
  if (incoming.size === 0) return 0;
  let shared = 0;
  for (const token of incoming) {
    if (existing.has(token)) shared += 1;
  }
  return shared / incoming.size;
};

const findSupersededEntry = (entries: MemoryEntry[], title: string, body: string) => {
  const lowerTitle = title.toLowerCase();
  const exact = entries.find((entry) => entry.title.toLowerCase() === lowerTitle);
  if (exact) return exact;

  const incoming = tokenize(`${title} ${body}`);
  if (incoming.size < DUPLICATE_MIN_TOKENS) return null;

  let best: MemoryEntry | null = null;
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

const findRelatedEntries = (entries: MemoryEntry[], title: string, body: string) => {
  const incoming = tokenize(`${title} ${body}`);
  if (incoming.size < DUPLICATE_MIN_TOKENS) return [];
  return entries
    .map((entry) => ({ entry, score: overlapFraction(incoming, tokenize(`${entry.title} ${entry.body}`)) }))
    .filter(({ score }) => score >= RELATED_OVERLAP_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    .slice(0, RELATED_LIMIT)
    .map(({ entry }) => entry);
};

const clampLength = (value: string, maxLength: number) => {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const limitForScope = (scope: MemoryScope) => (scope === 'global' ? GLOBAL_MEMORY_MAX_ITEMS : PROJECT_MEMORY_MAX_ITEMS);

const sanitizeEntries = (value: unknown[], now: number, scope: MemoryScope) => {
  const result: MemoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (result.length >= limitForScope(scope)) break;
    if (!isMemoryRecord(entry)) continue;

    const id = asNonEmptyString(entry.id);
    const title = clampLength(asNonEmptyString(entry.title) || '', MEMORY_TITLE_MAX_LENGTH);
    const body = clampLength(isMemoryText(entry.body) ? entry.body : '', MEMORY_BODY_MAX_LENGTH).trim();
    if (!id || !title || !body || seen.has(id)) continue;
    seen.add(id);

    const createdAt = isMemoryTimestamp(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : now;
    const sessionId = asNonEmptyString(entry.sessionId);
    const sanitized: MemoryEntry = {
      id,
      title,
      body,
      type: isMemoryType(entry.type) ? entry.type : 'fact',
      createdAt,
      updatedAt: isMemoryTimestamp(entry.updatedAt) && entry.updatedAt >= 0 ? entry.updatedAt : createdAt,
    };
    if (findThreatPattern(`${title}\n${body}`)) sanitized.flagged = true;
    if (sessionId) sanitized.sessionId = sessionId;
    result.push(sanitized);
  }

  return result.sort((a, b) => b.updatedAt - a.updatedAt);
};

const createEmptyMemory = (): MemoryDocument => ({ version: MEMORY_VERSION, entries: [] });

const hasRandomUuid = (value: Crypto | undefined): value is Crypto => (
  value !== undefined && typeof value.randomUUID === 'function'
);

export const createAgentMemoryRuntime = (deps: MemoryRuntimeDependencies) => {
  const { fsPromises, path, projectsDirPath, userConfigRoot, createId } = deps;

  const idFactory = createId
    ? createId
    : () => (hasRandomUuid(globalThis.crypto)
      ? crypto.randomUUID()
      : `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

  const writeLocks = new Map<string, Promise<void>>();

  const sanitizeProjectId = (projectId: string | undefined) => {
    const value = asNonEmptyString(projectId);
    if (!value) {
      throw new Error('projectId is required');
    }
    if (!PROJECT_ID_PATTERN.test(value)) {
      throw new Error('projectId contains unsupported characters');
    }
    return value;
  };

  const resolveTarget = (target: MemoryTarget): ResolvedMemoryTarget => {
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

  const readJson = async (filePath: string) => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMemoryRecord(error) && error.code === 'ENOENT') return { missing: true, value: null };
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return { missing: false, value: isMemoryRecord(parsed) ? parsed : null };
    } catch {
      return { missing: false, value: null };
    }
  };

  const writeJsonAtomic = async (filePath: string, value: MemoryDocument | (StoredDreamState & { version: number })) => {
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

  const withWriteLock = async <T>(key: string, mutate: () => Promise<T>): Promise<T> => {
    const previous = writeLocks.get(key) || Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
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

  const read = async (target: MemoryTarget) => {
    const resolved = resolveTarget(target);
    const stored = await readJson(resolved.filePath);

    if (!stored.missing) {
      if (!stored.value || !Array.isArray(stored.value.entries)) {
        throw new Error('Stored agent memory is malformed');
      }
      return {
        version: MEMORY_VERSION,
        entries: sanitizeEntries(stored.value.entries, Date.now(), resolved.scope),
      };
    }
    return createEmptyMemory();
  };

  const write = async (resolved: ResolvedMemoryTarget, entries: MemoryEntry[]) => {
    await writeJsonAtomic(resolved.filePath, { version: MEMORY_VERSION, entries });
  };

  const create = async (target: MemoryTarget, value: MemoryWriteInput) => {
    const resolved = resolveTarget(target);
    const title = clampLength(asNonEmptyString(value?.title) || '', MEMORY_TITLE_MAX_LENGTH);
    if ((asNonEmptyString(value?.body)?.length ?? 0) > MEMORY_BODY_MAX_LENGTH && isMemoryText(value.body)) {
      throw new Error(`body holds at most ${MEMORY_BODY_MAX_LENGTH} characters, and this one is ${value.body.trim().length}`);
    }
    const body = clampLength(isMemoryText(value?.body) ? value.body : '', MEMORY_BODY_MAX_LENGTH).trim();
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
        };
        if (isMemoryType(value?.type)) updated.type = value.type;
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
      const entry: MemoryEntry = {
        id: idFactory(),
        title,
        body,
        type: isMemoryType(value?.type) ? value.type : 'fact',
        createdAt: now,
        updatedAt: now,
      };
      if (findThreatPattern(`${title}\n${body}`)) entry.flagged = true;
      if (sessionId) entry.sessionId = sessionId;
      const related = findRelatedEntries(current.entries, title, body);
      const entries = [entry, ...current.entries];
      await write(resolved, entries);
      return { entry, entries, replaced: false, related };
    });
  };

  const update = async (target: MemoryTarget, memoryId: string | undefined, patch: MemoryWriteInput) => {
    const resolved = resolveTarget(target);
    const id = asNonEmptyString(memoryId);
    if (!id) throw new Error('memoryId is required');

    const patchTitle = patch?.title;
    const patchBody = patch?.body;
    const patchType = patch?.type;
    const hasTitle = isMemoryText(patchTitle);
    const hasBody = isMemoryText(patchBody);
    const hasType = isMemoryType(patchType);
    if (!hasTitle && !hasBody && !hasType) {
      throw new Error('title, body or type is required');
    }
    const title = hasTitle ? clampLength(patchTitle, MEMORY_TITLE_MAX_LENGTH).trim() : null;
    if (hasBody && (asNonEmptyString(patchBody)?.length ?? 0) > MEMORY_BODY_MAX_LENGTH) {
      throw new Error(`body holds at most ${MEMORY_BODY_MAX_LENGTH} characters, and this one is ${patchBody.trim().length}`);
    }
    const body = hasBody ? clampLength(patchBody, MEMORY_BODY_MAX_LENGTH).trim() : null;
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
        updatedAt: Date.now(),
      };
      if (title !== null) updated.title = title;
      if (body !== null) updated.body = body;
      if (hasType) updated.type = patchType;
      delete updated.flagged;
      if (findThreatPattern(`${updated.title}\n${updated.body}`)) updated.flagged = true;
      const entries = current.entries.map((entry) => (entry.id === id ? updated : entry));
      await write(resolved, entries);
      return { entry: updated, entries };
    });
  };

  const remove = async (target: MemoryTarget, memoryId: string | undefined) => {
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

  const readAll = async (projectId: string | null) => {
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

  const dreamStatePath = (resolved: ResolvedMemoryTarget) => path.join(path.dirname(resolved.filePath), 'memory-dream.json');

  const readDreamState = async (target: MemoryTarget): Promise<DreamState> => {
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

  const writeDreamState = async (resolved: ResolvedMemoryTarget, state: StoredDreamState) => {
    await writeJsonAtomic(dreamStatePath(resolved), {
      version: MEMORY_VERSION,
      lastRunAt: state.lastRunAt,
      record: state.record,
      snapshot: state.snapshot,
      after: state.after,
    });
  };

  const recordDream = async (target: MemoryTarget, { lastRunAt, record, snapshot, after = null }: DreamWriteInput) => {
    const resolved = resolveTarget(target);
    return withWriteLock(resolved.key, async () => {
      const state: StoredDreamState = {
        lastRunAt,
        record: dreamRecordSchema.nullable().catch(null).parse(record ?? null),
        snapshot: Array.isArray(snapshot) ? snapshot : null,
        after: Array.isArray(snapshot) && Array.isArray(after) ? after : null,
      };
      await writeDreamState(resolved, state);
      return state;
    });
  };

  const undoDream = async (target: MemoryTarget) => {
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

export type AgentMemoryRuntime = ReturnType<typeof createAgentMemoryRuntime>;
