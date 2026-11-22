/**
 * Project context storage: notes, todos, and plan files.
 *
 * The server is the sole writer of `<projectsDir>/<projectId>/context.json`.
 * The sibling `<projectsDir>/<projectId>.json` stays client-owned (worktree
 * setup, draft starters, project actions) and server-owned only for
 * `version`/`scheduledTasks`; keeping the two apart is what removes the
 * cross-process read-modify-write race that a shared file would create.
 *
 * Plan bodies live as markdown at `<projectsDir>/<projectId>/plans/<file>.md`
 * and are referenced by base name only, so moving the project storage
 * directory never invalidates a reference.
 */

import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import { asNonEmptyString, isRecord as isObjectRecord } from '../shared/guards.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { createPlanSummaryCache, readBoundedUtf8, PLAN_FILE_READ_MAX_BYTES } from './plan-progress.js';
import { z } from 'zod';

const optionalTextInput = z.string().optional();
const completedInput = z.boolean();

const PROJECT_CONTEXT_VERSION = 2;
const PROJECT_NOTE_BODY_MAX_LENGTH = 3000;
const PROJECT_NOTE_MAX_ITEMS = 200;
const PROJECT_TODO_TEXT_MAX_LENGTH = 1000;
const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;
const PROJECT_PLAN_BODY_MAX_LENGTH = 200_000;
const PROJECT_TODO_MAX_ITEMS = 500;
/**
 * Todo ids are client-named (the panel names the id it already shows), so
 * they were the one stored field a caller could grow without limit: text
 * is clamped and the count is capped, but an unbounded id let ~10 create
 * requests push context.json past CONTEXT_FILE_READ_MAX_BYTES, after
 * which every read judged the file malformed (#2113). Generated ids are
 * UUIDs (36 chars); 128 leaves generous headroom for client-chosen ids
 * while keeping 500 ids at ~64k chars, inside the read-cap budget
 * computed at CONTEXT_FILE_READ_MAX_BYTES below.
 */
export const PROJECT_TODO_ID_MAX_LENGTH = 128;
const PROJECT_PLAN_MAX_ITEMS = 500;

/**
 * Read cap for context.json (and the legacy <stem>.json read through
 * the same helper). A legitimate file is bounded by the write-side
 * clamps above: notes at most 200 x 3,000 chars, todos at most
 * 500 x 1,000 chars, plan links at most 500 x ~300 chars, plus
 * planSessions entries - roughly 1.3M chars in total. At UTF-8's
 * widest (4 bytes per char) that is a worst-case legitimate file of
 * ~5.2 MB. 8 MiB gives headroom over that worst case (the previous
 * 4 MiB cap sat below it, so a legitimate all-multibyte store could
 * have been refused as malformed) while keeping one oversized file
 * from being buffered whole.
 */
export const CONTEXT_FILE_READ_MAX_BYTES = 8 * 1024 * 1024;

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const PLAN_FILE_PATTERN = /^[a-zA-Z0-9._-]+\.md$/;

// The clamp must not split a surrogate pair: a value cut right after a high
// surrogate drops that half, because the clamped value is persisted and
// rendered, where a lone surrogate becomes U+FFFD permanently (#2010).
const clampLength = (value, maxLength) => {
  if (typeof value !== 'string') {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }
  const cut = value.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

const NOTE_SOURCES = new Set(['manual', 'selection', 'agent']);

const sanitizeNoteOrigin = (value) => {
  if (!isObjectRecord(value)) return null;
  const sessionId = asNonEmptyString(value.sessionId);
  const messageId = asNonEmptyString(value.messageId);
  if (!sessionId) return null;
  return messageId ? { sessionId, messageId } : { sessionId };
};

/**
 * Notes are a list of entries.
 *
 * Version 1 stored a single string. It is converted here rather than in a
 * separate migration pass so that any read — including one that races another
 * writer — sees the same shape.
 */
const sanitizeNotes = (value, now) => {
  if (typeof value === 'string') {
    const body = clampLength(value, PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!body) return [];
    return [{
      id: `note_legacy_${now}`,
      body,
      createdAt: now,
      updatedAt: now,
      source: 'manual',
      pinned: false,
    }];
  }

  if (!Array.isArray(value)) return [];

  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (result.length >= PROJECT_NOTE_MAX_ITEMS) break;
    if (!isObjectRecord(entry)) continue;
    const id = asNonEmptyString(entry.id);
    const body = clampLength(typeof entry.body === 'string' ? entry.body : '', PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!id || !body || seen.has(id)) continue;
    seen.add(id);

    const createdAt = Number.isFinite(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : now;
    const origin = sanitizeNoteOrigin(entry.origin);
    result.push({
      id,
      body,
      createdAt,
      updatedAt: Number.isFinite(entry.updatedAt) && entry.updatedAt >= 0 ? entry.updatedAt : createdAt,
      source: NOTE_SOURCES.has(entry.source) ? entry.source : 'manual',
      pinned: entry.pinned === true,
      ...(origin ? { origin } : {}),
    });
  }

  return result.sort((a, b) => b.createdAt - a.createdAt);
};

const sanitizeTodos = (value, now) => {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (result.length >= PROJECT_TODO_MAX_ITEMS) break;
    if (!isObjectRecord(entry)) continue;
    const id = asNonEmptyString(entry.id);
    const text = clampLength(asNonEmptyString(entry.text) || '', PROJECT_TODO_TEXT_MAX_LENGTH);
    if (!id || id.length > PROJECT_TODO_ID_MAX_LENGTH || !text || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      text,
      completed: entry.completed === true,
      createdAt: Number.isFinite(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : now,
    });
  }
  return result;
};

const sanitizePlanTitle = (value) => clampLength(asNonEmptyString(value) || '', PROJECT_PLAN_TITLE_MAX_LENGTH);

export const parsePlanMarkdown = (raw) => {
  const normalized = (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (match) {
    return {
      title: sanitizePlanTitle(match[1]) || 'Plan',
      body: normalized.slice(match[0].length).replace(/^\n+/, ''),
    };
  }
  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || 'Plan';
  return {
    title: sanitizePlanTitle(firstLine.replace(/^#+\s*/, '')) || 'Plan',
    body: normalized.trim(),
  };
};

const formatPlanMarkdown = (title, body) => {
  const normalizedTitle = sanitizePlanTitle(title) || 'Plan';
  const normalizedBody = typeof body === 'string' ? body.trim() : '';
  return normalizedBody ? `# ${normalizedTitle}\n\n${normalizedBody}` : `# ${normalizedTitle}\n`;
};

const slugifyPlanTitle = (value) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`*_#>[\](){}.!?,:;"']/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'plan';
};

const sanitizePlanLinks = (value, now) => {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seenIds = new Set();
  const seenFiles = new Set();
  for (const entry of value) {
    if (result.length >= PROJECT_PLAN_MAX_ITEMS) break;
    if (!isObjectRecord(entry)) continue;
    const id = asNonEmptyString(entry.id);
    const file = asNonEmptyString(entry.file);
    if (!id || !file || !PLAN_FILE_PATTERN.test(file)) continue;
    // A personal file and a shared file may carry the same name: they live in different folders.
    const shared = entry.shared === true;
    const fileKey = `${shared ? 'shared' : 'personal'}/${file}`;
    if (seenIds.has(id) || seenFiles.has(fileKey)) continue;
    seenIds.add(id);
    seenFiles.add(fileKey);
    result.push({
      id,
      file,
      title: sanitizePlanTitle(entry.title) || 'Plan',
      createdAt: Number.isFinite(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : now,
      pinned: entry.pinned === true,
      // The user's own plan that was moved into the team's folder: it keeps
      // its id (session attachments still point at it) and this flag says
      // which folder holds the file.
      shared,
    });
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
};

/**
 * The session a plan was last sent to with Implement or Improve, keyed by plan
 * id. A map beside the manifest rather than a field on the link, because a
 * plan that only lives in the team's folder has no link to carry it.
 */
const sanitizePlanSessions = (value) => {
  if (!isObjectRecord(value)) return {};
  const result = {};
  for (const [planId, entry] of Object.entries(value).slice(0, PROJECT_PLAN_MAX_ITEMS)) {
    if (!asNonEmptyString(planId) || !isObjectRecord(entry)) continue;
    const sessionId = asNonEmptyString(entry.sessionId);
    if (!sessionId) continue;
    result[planId] = {
      sessionId,
      linkedAt: Number.isFinite(entry.linkedAt) && entry.linkedAt >= 0 ? entry.linkedAt : 0,
    };
  }
  return result;
};

const createEmptyContext = () => ({
  version: PROJECT_CONTEXT_VERSION,
  notes: [],
  todos: [],
  plans: [],
  planSessions: {},
});

const SHARED_PLAN_ID_PREFIX = 'shared:';

const mutationError = (message, status) => Object.assign(new Error(message), { status });

/** A listed plan with its checklist counts, when it has a checklist. */
const withProgress = (plan, progress) => (progress ? { ...plan, progress } : plan);

const withoutKey = (record, key) => {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

const insertTodoBeforeCompleted = (items, item) => {
  const firstCompletedIndex = items.findIndex((todo) => todo.completed);
  if (firstCompletedIndex === -1) return [...items, item];
  return [...items.slice(0, firstCompletedIndex), item, ...items.slice(firstCompletedIndex)];
};

const todoText = (value) => {
  const text = asNonEmptyString(value);
  if (!text) throw mutationError('text is required', 400);
  if (text.length > PROJECT_TODO_TEXT_MAX_LENGTH) {
    throw mutationError(`text must be at most ${PROJECT_TODO_TEXT_MAX_LENGTH} characters`, 400);
  }
  return text;
};

export const createProjectContextRuntime = (deps) => {
  const { fsPromises, path, projectsDirPath, createId, resolveSharedPlansDir, onChanged, readPlanMetrics } = deps;
  // The team's shared plans folder for a project (absolute path) or null; the
  // project config runtime owns that answer (`plansDir` in the shared file).
  const sharedPlansDirFor = typeof resolveSharedPlansDir === 'function'
    ? resolveSharedPlansDir
    : async () => null;

  const planSummaries = createPlanSummaryCache({ fsPromises, parseTitle: (raw) => parsePlanMarkdown(raw).title });

  const idFactory = typeof createId === 'function'
    ? createId
    : () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `plan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

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

  // The folder and the client-owned config file share one bounded stem
  // (`projectConfigFileStemOf`): an id too long for a file name would
  // otherwise fail every read with ENAMETOOLONG instead of reading as empty.
  const storageStemFor = (projectId) => projectConfigFileStemOf(sanitizeProjectId(projectId));
  const storageDirFor = (projectId) => path.join(projectsDirPath, storageStemFor(projectId));
  const contextPathFor = (projectId) => path.join(storageDirFor(projectId), 'context.json');
  const plansDirFor = (projectId) => path.join(storageDirFor(projectId), 'plans');
  const legacyConfigPathFor = (projectId) => path.join(projectsDirPath, `${storageStemFor(projectId)}.json`);

  const readJson = async (filePath) => {
    const result = await readBoundedFile(filePath, CONTEXT_FILE_READ_MAX_BYTES);
    if (!result.ok) {
      // Missing stays authoritative empty. An over-cap or non-regular
      // target follows the malformed path (value null, not missing):
      // it must never silently read as empty.
      return result.reason === 'missing'
        ? { missing: true, value: null }
        : { missing: false, value: null };
    }
    try {
      const parsed = JSON.parse(result.buffer.toString('utf8'));
      return { missing: false, value: isObjectRecord(parsed) ? parsed : null };
    } catch {
      return { missing: false, value: null };
    }
  };

  const writeJsonAtomic = async (filePath, value) => {
    const serialized = JSON.stringify(value, null, 2);
    // Fail closed before replacing the last valid file: a store the
    // bounded read would refuse as malformed must never be written in
    // the first place (#2113). The field clamps bound every legitimate
    // store well under this cap; this is the aggregate backstop.
    if (Buffer.byteLength(serialized, 'utf8') > CONTEXT_FILE_READ_MAX_BYTES) {
      throw mutationError(`Stored project context would exceed the ${CONTEXT_FILE_READ_MAX_BYTES}-byte read cap; refusing to write`, 413);
    }
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsPromises.writeFile(temporaryPath, serialized, 'utf8');
      await renameWithRetry((from, to) => fsPromises.rename(from, to), temporaryPath, filePath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const withWriteLock = async (projectId, mutate) => {
    const key = sanitizeProjectId(projectId);
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
   * One-time migration of `projectNotes` / `projectTodos` / `projectPlanFiles`
   * out of the client-owned `<projectId>.json`.
   *
   * Plan links carried absolute paths; those are converted to base names. A
   * referenced file that is not already inside the plans directory is moved
   * there so a stale absolute path from an earlier project id is recovered
   * rather than dropped. A link whose file cannot be located at all is kept
   * out of the result — the markdown is gone, so the link is dead either way.
   *
   * The legacy keys are removed only after `context.json` is durably written.
   * A failure at any point leaves the legacy keys in place, so the migration
   * simply runs again on the next read.
   */
  const migrateFromLegacyConfig = async (projectId, now) => {
    const legacyPath = legacyConfigPathFor(projectId);
    const legacy = await readJson(legacyPath);
    if (!legacy.value) {
      return null;
    }

    const hasLegacyKeys = legacy.value.projectNotes !== undefined
      || legacy.value.projectTodos !== undefined
      || legacy.value.projectPlanFiles !== undefined;
    if (!hasLegacyKeys) {
      return null;
    }

    const plansDir = plansDirFor(projectId);
    const links = [];
    const rawLinks = Array.isArray(legacy.value.projectPlanFiles) ? legacy.value.projectPlanFiles : [];
    for (const entry of rawLinks) {
      if (!isObjectRecord(entry)) continue;
      const id = asNonEmptyString(entry.id);
      const absolutePath = asNonEmptyString(entry.path);
      if (!id || !absolutePath) continue;

      const file = path.basename(absolutePath);
      if (!PLAN_FILE_PATTERN.test(file)) continue;
      const targetPath = path.join(plansDir, file);

      let raw = null;
      try {
        raw = await readPlanFile(targetPath);
      } catch (error) {
        // An over-cap legacy plan is skipped, never buffered whole: the
        // cap is a property of the module, and the migration still
        // completes for the remaining items.
        if (!error || error.status !== 413) throw error;
        continue;
      }
      if (raw === null) {
        // Not in the plans directory yet — recover it from the recorded path.
        try {
          raw = await readPlanFile(absolutePath);
        } catch (recoverError) {
          if (!recoverError || recoverError.status !== 413) throw recoverError;
          continue;
        }
        if (raw === null) continue;
        await fsPromises.mkdir(plansDir, { recursive: true });
        await fsPromises.writeFile(targetPath, raw, 'utf8');
      }

      links.push({
        id,
        file,
        title: parsePlanMarkdown(raw).title,
        createdAt: Number.isFinite(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : now,
      });
    }

    const migrated = {
      version: PROJECT_CONTEXT_VERSION,
      notes: sanitizeNotes(legacy.value.projectNotes, now),
      todos: sanitizeTodos(legacy.value.projectTodos, now),
      plans: sanitizePlanLinks(links, now),
    };

    await writeJsonAtomic(contextPathFor(projectId), migrated);

    const remaining = { ...legacy.value };
    delete remaining.projectNotes;
    delete remaining.projectTodos;
    delete remaining.projectPlanFiles;
    await writeJsonAtomic(legacyPath, remaining);

    return migrated;
  };

  /**
   * Read the stored context.
   *
   * Distinguishes the three states the caller must not conflate: a missing
   * file is authoritative empty, malformed JSON is a failure, and an I/O
   * error propagates. Never returns an empty context to paper over a read
   * that did not succeed.
   *
   * Deliberately does NOT take the write lock: every mutator calls this while
   * already holding it, so locking here would deadlock. The legacy migration
   * it can trigger is safe unlocked — both of its writes are atomic renames
   * of identical content, so concurrent migrations converge instead of
   * interleaving.
   */
  const readStoredContext = async (projectId) => {
    const now = Date.now();
    const stored = await readJson(contextPathFor(projectId));

    if (!stored.missing && !stored.value) {
      throw new Error('Stored project context is malformed');
    }

    if (stored.missing) {
      const migrated = await migrateFromLegacyConfig(projectId, now);
      if (migrated) {
        return {
          version: PROJECT_CONTEXT_VERSION,
          notes: sanitizeNotes(migrated.notes, now),
          todos: sanitizeTodos(migrated.todos, now),
          plans: sanitizePlanLinks(migrated.plans, now),
          planSessions: {},
        };
      }
      return createEmptyContext();
    }

    return {
      version: PROJECT_CONTEXT_VERSION,
      notes: sanitizeNotes(stored.value.notes, now),
      todos: sanitizeTodos(stored.value.todos, now),
      plans: sanitizePlanLinks(stored.value.plans, now),
      planSessions: sanitizePlanSessions(stored.value.planSessions),
    };
  };

  /** The file name behind a shared plan id, or null when the id is not one. */
  const sharedPlanFileOf = (planId) => {
    if (typeof planId !== 'string' || !planId.startsWith(SHARED_PLAN_ID_PREFIX)) return null;
    const file = planId.slice(SHARED_PLAN_ID_PREFIX.length);
    return PLAN_FILE_PATTERN.test(file) ? file : null;
  };

  /**
   * Plans in the team's shared folder: every `.md` file there, newest first,
   * addressed by `shared:<file>`. Plans written by other tools have no
   * manifest entry, so the title comes from the file each time.
   */
  const listSharedPlans = async (projectId, claimedFiles = new Set()) => {
    const dir = await sharedPlansDirFor(projectId);
    if (!dir) return { dir: null, plans: [] };
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return { dir, plans: [] };
      throw error;
    }
    const plans = [];
    for (const entry of entries) {
      if (!entry.isFile() || !PLAN_FILE_PATTERN.test(entry.name)) continue;
      // Listed under its own id by the manifest entry that moved it there.
      if (claimedFiles.has(entry.name)) continue;
      const summary = await planSummaries.summaryOf(path.join(dir, entry.name));
      // Removed between the directory read and this one.
      if (!summary) continue;
      const listed = {
        id: `${SHARED_PLAN_ID_PREFIX}${entry.name}`,
        file: entry.name,
        title: summary.title,
        createdAt: Math.round(summary.mtimeMs),
        pinned: false,
        source: 'shared',
      };
      if (summary.tooLarge) listed.tooLarge = true;
      plans.push(withProgress(listed, summary.progress));
    }
    plans.sort((left, right) => right.createdAt - left.createdAt);
    return { dir, plans };
  };

  /**
   * Progress of one of the user's own plans. The list must not fail because
   * one plan file could not be read, so an unreadable file shows no progress,
   * the same as a plan without a checklist.
   */
  const progressOfLink = async (projectId, link, sharedDir) => {
    const folder = link.shared ? sharedDir : plansDirFor(projectId);
    if (!folder) return null;
    try {
      const summary = await planSummaries.summaryOf(path.join(folder, link.file));
      if (!summary) return null;
      return { progress: summary.progress ?? null, tooLarge: summary.tooLarge === true };
    } catch {
      return null;
    }
  };

  /**
   * What clients see: the stored context plus the team's shared plans, each
   * marked with its source, its checklist progress and the session it was
   * last sent to.
   */
  const readContext = async (projectId) => {
    const { planSessions, ...stored } = await readStoredContext(projectId);
    const claimed = new Set(stored.plans.filter((plan) => plan.shared).map((plan) => plan.file));
    const shared = await listSharedPlans(projectId, claimed);
    const own = await Promise.all(stored.plans
      // A moved plan is only reachable while the project still has a shared folder.
      .filter((plan) => !plan.shared || shared.dir)
      .map(async ({ shared: isShared, ...plan }) => {
        const info = await progressOfLink(projectId, { ...plan, shared: isShared }, shared.dir);
        const listed = withProgress({ ...plan, source: isShared ? 'shared' : 'personal' }, info?.progress ?? null);
        return info?.tooLarge ? { ...listed, tooLarge: true } : listed;
      }));
    const withSession = (plan) => (planSessions[plan.id] ? { ...plan, session: planSessions[plan.id] } : plan);
    const plans = [...own, ...shared.plans].map(withSession);
    // Metrics are a display enrichment on the linked session, read live and
    // never stored: a plan whose session cannot be read shows no metrics,
    // the same tolerance progress has. Without a reader (tests, embedding)
    // plans carry no metrics at all.
    const withMetrics = readPlanMetrics
      ? await Promise.all(plans.map(async (plan) => {
          if (!plan.session?.sessionId) return plan;
          let metrics = null;
          try {
            metrics = await readPlanMetrics(plan.session.sessionId);
          } catch {
            metrics = null;
          }
          return metrics ? { ...plan, metrics } : plan;
        }))
      : plans;
    return {
      ...stored,
      plans: withMetrics,
      sharedPlansDir: shared.dir,
    };
  };

  /** One plan as clients see it, read back from the committed context. */
  const publicPlanOf = async (projectId, planId) => {
    const context = await readContext(projectId);
    return { plan: context.plans.find((entry) => entry.id === planId) ?? null, context };
  };

  /** The folder a manifest plan's file lives in; null for a moved plan when the project lost its shared folder. */
  const folderOfLink = async (projectId, link) => (link.shared ? sharedPlansDirFor(projectId) : plansDirFor(projectId));

  const writeContext = async (projectId, context) => {
    await writeJsonAtomic(contextPathFor(projectId), {
      version: PROJECT_CONTEXT_VERSION,
      notes: context.notes,
      todos: context.todos,
      plans: context.plans,
      planSessions: context.planSessions ?? {},
    });
    onChanged?.(sanitizeProjectId(projectId));
  };

  const saveTodos = async (projectId, todos) => {
    return withWriteLock(projectId, async () => {
      const now = Date.now();
      const current = await readStoredContext(projectId);
      const next = { ...current, todos: sanitizeTodos(todos, now) };
      await writeContext(projectId, next);
      return next;
    });
  };

  /**
   * Adds one todo, an open one ahead of the completed ones and a done one at
   * the end; answers with it and the committed context. The panel names the id it already shows, so a check
   * made before this answer arrives addresses the same todo; a taken or
   * missing id gets a fresh one.
   */
  const createTodo = async (projectId, value) => {
    const text = todoText(value?.text);
    const requestedId = asNonEmptyString(value?.id);
    if (requestedId && requestedId.length > PROJECT_TODO_ID_MAX_LENGTH) {
      throw mutationError(`Todo id must be at most ${PROJECT_TODO_ID_MAX_LENGTH} characters`, 400);
    }
    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (current.todos.length >= PROJECT_TODO_MAX_ITEMS) {
        throw mutationError(`A project can hold at most ${PROJECT_TODO_MAX_ITEMS} todos`, 400);
      }
      const id = requestedId && !current.todos.some((todo) => todo.id === requestedId) ? requestedId : idFactory();
      const todo = { id, text, completed: value?.completed === true, createdAt: Date.now() };
      const next = { ...current, todos: todo.completed ? [...current.todos, todo] : insertTodoBeforeCompleted(current.todos, todo) };
      await writeContext(projectId, next);
      return { todo, context: next };
    });
  };

  const updateTodo = async (projectId, todoId, patch) => {
    const id = asNonEmptyString(todoId);
    if (!id) throw mutationError('todoId is required', 400);
    const hasText = patch?.text !== undefined;
    const hasCompleted = patch?.completed !== undefined;
    if (!hasText && !hasCompleted) throw mutationError('text or completed is required', 400);
    const text = hasText ? todoText(patch.text) : null;
    const completed = completedInput.safeParse(patch?.completed);
    if (hasCompleted && !completed.success) {
      throw mutationError('completed must be a boolean', 400);
    }
    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const existing = current.todos.find((todo) => todo.id === id);
      if (!existing) throw mutationError('Todo not found', 404);
      const updated = { ...existing };
      if (hasText) updated.text = text;
      if (hasCompleted) updated.completed = completed.data;
      let todos;
      if (updated.completed !== existing.completed) {
        const remaining = current.todos.filter((todo) => todo.id !== id);
        todos = updated.completed ? [...remaining, updated] : insertTodoBeforeCompleted(remaining, updated);
      } else {
        todos = current.todos.map((todo) => todo.id === id ? updated : todo);
      }
      const next = { ...current, todos };
      await writeContext(projectId, next);
      return next;
    });
  };

  const deleteTodo = async (projectId, todoId) => {
    const id = asNonEmptyString(todoId);
    if (!id) throw mutationError('todoId is required', 400);
    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (!current.todos.some((todo) => todo.id === id)) throw mutationError('Todo not found', 404);
      const next = { ...current, todos: current.todos.filter((todo) => todo.id !== id) };
      await writeContext(projectId, next);
      return next;
    });
  };

  /**
   * Notes are addressed individually.
   *
   * Splitting them from todos is what lets the panel stop writing both fields
   * on every keystroke-driven save: a todo toggle can no longer clobber notes
   * the user is still typing, and an agent-authored note can no longer lose a
   * concurrent todo change.
   */
  const createNote = async (projectId, value) => {
    const body = clampLength(typeof value?.body === 'string' ? value.body : '', PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!body) {
      throw new Error('body is required');
    }

    return withWriteLock(projectId, async () => {
      const now = Date.now();
      const current = await readStoredContext(projectId);
      if (current.notes.length >= PROJECT_NOTE_MAX_ITEMS) {
        throw mutationError(`A project can hold at most ${PROJECT_NOTE_MAX_ITEMS} notes`, 400);
      }

      const note = {
        id: idFactory(),
        body,
        createdAt: now,
        updatedAt: now,
        source: NOTE_SOURCES.has(value?.source) ? value.source : 'manual',
        pinned: false,
        ...(sanitizeNoteOrigin(value?.origin) ? { origin: sanitizeNoteOrigin(value.origin) } : {}),
      };

      const next = { ...current, notes: [note, ...current.notes] };
      await writeContext(projectId, next);
      return { note, context: next };
    });
  };

  /**
   * Patch one note. Omitted fields are left alone, so pinning a note cannot
   * roll back an edit that landed between the two requests.
   */
  const updateNote = async (projectId, noteId, patch, options = {}) => {
    const id = asNonEmptyString(noteId);
    if (!id) {
      throw new Error('noteId is required');
    }
    const hasBody = typeof patch?.body === 'string';
    const hasPinned = typeof patch?.pinned === 'boolean';
    if (!hasBody && !hasPinned) {
      throw new Error('body or pinned is required');
    }
    const body = hasBody ? clampLength(patch.body, PROJECT_NOTE_BODY_MAX_LENGTH).trim() : null;
    if (hasBody && !body) {
      throw new Error('body is required');
    }
    const expectedBody = optionalTextInput.safeParse(options.expectedBody);
    if (!expectedBody.success) {
      throw mutationError('expectedBody must be a string', 400);
    }

    return withWriteLock(projectId, async () => {
      const now = Date.now();
      const current = await readStoredContext(projectId);
      const existing = current.notes.find((note) => note.id === id);
      if (!existing) {
        return null;
      }
      if (expectedBody.data !== undefined && expectedBody.data !== existing.body) {
        throw mutationError('Project note changed; reload before saving', 409);
      }

      const note = {
        ...existing,
        ...(hasBody ? { body, updatedAt: now } : {}),
        ...(hasPinned ? { pinned: patch.pinned } : {}),
      };
      const next = { ...current, notes: current.notes.map((entry) => (entry.id === id ? note : entry)) };
      await writeContext(projectId, next);
      return { note, context: next };
    });
  };

  const deleteNote = async (projectId, noteId) => {
    const id = asNonEmptyString(noteId);
    if (!id) {
      throw new Error('noteId is required');
    }

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (!current.notes.some((note) => note.id === id)) {
        return { deleted: false, context: current };
      }
      const next = { ...current, notes: current.notes.filter((note) => note.id !== id) };
      await writeContext(projectId, next);
      return { deleted: true, context: next };
    });
  };

  /**
   * Read a plan file whole, gated on its size: a plan over
   * PLAN_FILE_READ_MAX_BYTES is refused (413) from its stat alone, so an
   * oversized file other tools wrote is never buffered whole. A missing
   * file returns null, the answer readPlan has always given for a plan
   * that is gone.
   */
  const readPlanFile = async (planPath) => {
    let stat;
    try {
      stat = await fsPromises.stat(planPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.size > PLAN_FILE_READ_MAX_BYTES) {
      throw mutationError(`Plan file is too large to read (${stat.size} bytes; limit is ${PLAN_FILE_READ_MAX_BYTES} bytes)`, 413);
    }
    let raw;
    try {
      raw = await readBoundedUtf8(fsPromises, planPath, PLAN_FILE_READ_MAX_BYTES);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (raw === null) {
      // Grew past the cap between the stat above and this read.
      throw mutationError(`Plan file is too large to read (limit is ${PLAN_FILE_READ_MAX_BYTES} bytes)`, 413);
    }
    return raw;
  };

  const readPlan = async (projectId, planId) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }
    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir) return null;
      const planPath = path.join(dir, sharedFile);
      const raw = await readPlanFile(planPath);
      if (raw === null) return null;
      const parsed = parsePlanMarkdown(raw);
      return { id, file: sharedFile, path: planPath, createdAt: 0, title: parsed.title, body: parsed.body, raw, source: 'shared' };
    }
    const context = await readStoredContext(projectId);
    const link = context.plans.find((entry) => entry.id === id);
    if (!link) {
      return null;
    }

    const folder = await folderOfLink(projectId, link);
    if (!folder) return null;
    const planPath = path.join(folder, link.file);
    const raw = await readPlanFile(planPath);
    if (raw === null) return null;

    const parsed = parsePlanMarkdown(raw);
    return { id: link.id, file: link.file, path: planPath, createdAt: link.createdAt, title: parsed.title, body: parsed.body, raw, source: link.shared ? 'shared' : 'personal' };
  };

  /**
   * Overwrite a plan's markdown in place.
   *
   * Takes the whole raw document, because the editor surface owns the file
   * verbatim — round-tripping through title + body would rewrite the heading
   * and silently reformat what the user typed. The manifest title is
   * re-derived from the saved content so the list never drifts from the file.
   *
   * The file name is deliberately not regenerated on a title change: it is the
   * stable identity behind the link, and renaming it would strand the markdown
   * if the manifest write failed afterwards.
   */
  const updatePlan = async (projectId, planId, value, options = {}) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }
    if (typeof value?.raw !== 'string') {
      throw new Error('raw is required');
    }
    const expectedRaw = optionalTextInput.safeParse(options.expectedRaw);
    if (!expectedRaw.success) {
      throw mutationError('expectedRaw must be a string', 400);
    }
    const raw = clampLength(value.raw, PROJECT_PLAN_BODY_MAX_LENGTH);
    const checkExpectedRaw = async (filePath) => {
      if (expectedRaw.data === undefined) return;
      // Compare through the capped read: an over-cap current file is
      // refused (413) instead of being buffered whole for the compare.
      const currentRaw = await readPlanFile(filePath);
      if (currentRaw !== expectedRaw.data) {
        throw mutationError('Plan changed; reload before saving', 409);
      }
    };

    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      // A shared plan is the file itself: written verbatim, no manifest.
      return withWriteLock(projectId, async () => {
        const dir = await sharedPlansDirFor(projectId);
        if (!dir) return null;
        const filePath = path.join(dir, sharedFile);
        try {
          await fsPromises.access(filePath);
        } catch (error) {
          if (error && error.code === 'ENOENT') return null;
          throw error;
        }
        await checkExpectedRaw(filePath);
        await fsPromises.writeFile(filePath, raw, 'utf8');
        onChanged?.(sanitizeProjectId(projectId));
        const parsed = parsePlanMarkdown(raw);
        const context = await readContext(projectId);
        const plan = context.plans.find((entry) => entry.id === id) ?? { id, file: sharedFile, title: parsed.title, createdAt: Date.now(), pinned: false, source: 'shared' };
        return { plan, context, title: parsed.title, body: parsed.body, raw };
      });
    }

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const link = current.plans.find((entry) => entry.id === id);
      if (!link) {
        return null;
      }

      const folder = await folderOfLink(projectId, link);
      if (!folder) return null;
      const filePath = path.join(folder, link.file);
      // Refuse to recreate a file that was deleted underneath us: the link is
      // already dead, and writing here would resurrect it with editor content
      // the user believed was discarded.
      try {
        await fsPromises.access(filePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }

      await checkExpectedRaw(filePath);
      await fsPromises.writeFile(filePath, raw, 'utf8');

      const parsed = parsePlanMarkdown(raw);
      const nextLink = { ...link, title: parsed.title };
      const next = {
        ...current,
        plans: current.plans.map((entry) => (entry.id === id ? nextLink : entry)),
      };
      await writeContext(projectId, next);

      const { plan, context } = await publicPlanOf(projectId, id);
      const { shared: isShared, ...publicLink } = nextLink;
      return { plan: plan ?? { ...publicLink, source: isShared ? 'shared' : 'personal' }, context, title: parsed.title, body: parsed.body, raw };
    });
  };

  /**
   * Create a plan from title + body.
   *
   * The markdown file is written before the manifest entry. A failure after
   * the file write leaves an unreferenced markdown file rather than a
   * manifest entry pointing at nothing — the orphan is inert, a dangling
   * entry would surface as a broken row in the UI.
   */
  const createPlan = async (projectId, value) => {
    const title = sanitizePlanTitle(value?.title) || 'Plan';
    const body = clampLength(typeof value?.body === 'string' ? value.body : '', PROJECT_PLAN_BODY_MAX_LENGTH);

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (current.plans.length >= PROJECT_PLAN_MAX_ITEMS) {
        throw mutationError(`A project can hold at most ${PROJECT_PLAN_MAX_ITEMS} personal plans`, 400);
      }
      const createdAt = Date.now();
      const plansDir = plansDirFor(projectId);
      await fsPromises.mkdir(plansDir, { recursive: true });

      const baseName = `${createdAt}-${slugifyPlanTitle(title)}`;
      let file = `${baseName}.md`;
      let attempt = 1;
      while (current.plans.some((entry) => !entry.shared && entry.file === file)) {
        file = `${baseName}-${attempt}.md`;
        attempt += 1;
      }

      await fsPromises.writeFile(path.join(plansDir, file), formatPlanMarkdown(title, body), 'utf8');

      const link = { id: idFactory(), file, title, createdAt, pinned: false };
      const next = { ...current, plans: [link, ...current.plans] };
      await writeContext(projectId, next);
      const { plan, context } = await publicPlanOf(projectId, link.id);
      return { plan: plan ?? { ...link, source: 'personal' }, context };
    });
  };

  /**
   * Delete a plan.
   *
   * The manifest entry is removed first so a failed file unlink cannot leave
   * the UI showing a plan that no longer opens. The leftover markdown is
   * unreferenced and harmless.
   */
  /** Pin state is patched on its own so it cannot roll back a concurrent edit. */
  const setPlanPinned = async (projectId, planId, pinned) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const existing = current.plans.find((entry) => entry.id === id);
      if (!existing) {
        return null;
      }
      const plan = { ...existing, pinned: pinned === true };
      const next = { ...current, plans: current.plans.map((entry) => (entry.id === id ? plan : entry)) };
      await writeContext(projectId, next);
      const committed = await publicPlanOf(projectId, id);
      const { shared: isShared, ...publicPlan } = plan;
      return { plan: committed.plan ?? { ...publicPlan, source: isShared ? 'shared' : 'personal' }, context: committed.context };
    });
  };

  const deletePlan = async (projectId, planId) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }

    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      return withWriteLock(projectId, async () => {
        const dir = await sharedPlansDirFor(projectId);
        const filePath = dir ? path.join(dir, sharedFile) : null;
        const exists = filePath ? await fsPromises.access(filePath).then(() => true, () => false) : false;
        if (!exists) return { deleted: false, context: await readContext(projectId) };
        await fsPromises.rm(filePath, { force: true });
        const current = await readStoredContext(projectId);
        if (current.planSessions[id]) {
          await writeContext(projectId, { ...current, planSessions: withoutKey(current.planSessions, id) });
        } else {
          onChanged?.(sanitizeProjectId(projectId));
        }
        return { deleted: true, context: await readContext(projectId) };
      });
    }

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const link = current.plans.find((entry) => entry.id === id);
      if (!link) {
        return { deleted: false, context: await readContext(projectId) };
      }

      const next = {
        ...current,
        plans: current.plans.filter((entry) => entry.id !== id),
        planSessions: withoutKey(current.planSessions, id),
      };
      await writeContext(projectId, next);
      const folder = await folderOfLink(projectId, link);
      if (folder) await fsPromises.rm(path.join(folder, link.file), { force: true });
      return { deleted: true, context: await readContext(projectId) };
    });
  };

  /** A free file name in `dir`, keeping the wanted base name unless it is taken. */
  const freeFileNameIn = async (dir, wanted, taken = new Set()) => {
    const base = wanted.replace(/\.md$/, '');
    let file = wanted;
    let attempt = 1;
    while (taken.has(file) || await fsPromises.access(path.join(dir, file)).then(() => true, () => false)) {
      file = `${base}-${attempt}.md`;
      attempt += 1;
    }
    return file;
  };

  const moveFile = async (from, to) => {
    try {
      await fsPromises.rename(from, to);
    } catch (error) {
      if (!error || error.code !== 'EXDEV') throw error;
      await fsPromises.copyFile(from, to);
      await fsPromises.rm(from, { force: true });
    }
  };

  /**
   * Move one of the user's plans into the team's shared folder. The plan
   * keeps its id: the manifest entry stays and gets the `shared` flag, so a
   * session that attached the plan still finds it. The markdown moves first,
   * then the manifest is written; a failure in between leaves the file in the
   * shared folder (listed there as `shared:<file>`) and a dead personal entry
   * that `readPlan` reports as gone. Needs a shared plans folder; refused
   * (validation error) when the project has none.
   */
  const sharePlan = async (projectId, planId) => {
    const id = asNonEmptyString(planId);
    if (!id) throw new Error('planId is required');
    return withWriteLock(projectId, async () => {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir) throw new Error('shared plans folder is required');
      const current = await readStoredContext(projectId);
      const link = current.plans.find((entry) => entry.id === id);
      if (!link || link.shared) return null;
      const from = path.join(plansDirFor(projectId), link.file);
      const exists = await fsPromises.access(from).then(() => true, () => false);
      if (!exists) return null;
      await fsPromises.mkdir(dir, { recursive: true });
      const file = await freeFileNameIn(dir, link.file);
      await moveFile(from, path.join(dir, file));
      const moved = { ...link, file, shared: true };
      await writeContext(projectId, { ...current, plans: current.plans.map((entry) => (entry.id === id ? moved : entry)) });
      const context = await readContext(projectId);
      return { plan: context.plans.find((entry) => entry.id === id), context };
    });
  };

  /**
   * Move a shared plan back into the user's own plans; the reverse of
   * `sharePlan`. A plan the user moved keeps its id; a plan that only ever
   * lived in the team's folder (`shared:<file>`) gets a manifest entry now.
   */
  const unsharePlan = async (projectId, planId) => {
    const id = asNonEmptyString(planId);
    if (!id) throw new Error('planId is required');
    return withWriteLock(projectId, async () => {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir) return null;
      const current = await readStoredContext(projectId);
      const ownLink = current.plans.find((entry) => entry.id === id && entry.shared);
      const sharedFile = ownLink ? ownLink.file : sharedPlanFileOf(id);
      if (!sharedFile) return null;
      const from = path.join(dir, sharedFile);
      // The title is all that is read here, and it goes through the
      // capped read: an over-cap shared plan is refused (413), never
      // buffered whole just to parse its first line.
      const raw = await readPlanFile(from);
      if (raw === null) return null;
      const plansDir = plansDirFor(projectId);
      await fsPromises.mkdir(plansDir, { recursive: true });
      const taken = new Set(current.plans.filter((entry) => !entry.shared).map((entry) => entry.file));
      const file = await freeFileNameIn(plansDir, sharedFile, taken);
      await moveFile(from, path.join(plansDir, file));
      const title = parsePlanMarkdown(raw).title;
      const link = ownLink
        ? { ...ownLink, file, title, shared: false }
        : { id: idFactory(), file, title, createdAt: Date.now(), pinned: false, shared: false };
      const plans = ownLink
        ? current.plans.map((entry) => (entry.id === id ? link : entry))
        : [link, ...current.plans];
      // A plan that only lived in the team's folder gets a new id here; the
      // session it was sent to follows it.
      const planSessions = !ownLink && current.planSessions[id]
        ? { ...withoutKey(current.planSessions, id), [link.id]: current.planSessions[id] }
        : current.planSessions;
      await writeContext(projectId, { ...current, plans, planSessions });
      const { shared: _movedFlag, ...publicLink } = link;
      const committed = await publicPlanOf(projectId, link.id);
      return { plan: committed.plan ?? { ...publicLink, source: 'personal' }, context: committed.context };
    });
  };

  /**
   * Record the session a plan was just sent to, so its card can lead there.
   * One session per plan: sending it again replaces the previous one.
   */
  const setPlanSession = async (projectId, planId, value) => {
    const id = asNonEmptyString(planId);
    if (!id) throw new Error('planId is required');
    const sessionId = asNonEmptyString(value?.sessionId);
    if (!sessionId) throw mutationError('sessionId is required', 400);

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const sharedFile = sharedPlanFileOf(id);
      if (sharedFile) {
        const dir = await sharedPlansDirFor(projectId);
        const exists = dir ? await fsPromises.access(path.join(dir, sharedFile)).then(() => true, () => false) : false;
        if (!exists) return null;
      } else if (!current.plans.some((entry) => entry.id === id)) {
        return null;
      }
      await writeContext(projectId, {
        ...current,
        planSessions: { ...current.planSessions, [id]: { sessionId, linkedAt: Date.now() } },
      });
      return publicPlanOf(projectId, id);
    });
  };

  return {
    readContext,
    setPlanSession,
    saveTodos,
    createTodo,
    updateTodo,
    deleteTodo,
    createNote,
    updateNote,
    deleteNote,
    readPlan,
    updatePlan,
    createPlan,
    setPlanPinned,
    deletePlan,
    sharePlan,
    unsharePlan,
    contextPathFor,
    plansDirFor,
  };
};
