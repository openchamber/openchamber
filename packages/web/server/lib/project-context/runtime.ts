import { asNonEmptyString } from '../shared/guards.js';
import { projectConfigFileStemOf } from '../projects/project-id.js';
import { createPlanSummaryCache } from './plan-progress.js';
import { z } from 'zod';
import type { NoteOrigin, NotesTodos, PlanInput, PlanLinks, PlanSessions, ProjectContext, ProjectContextDependencies, ProjectNote, ProjectTodo, PublicPlan, ReadPlan, StorageSwitch, StoredContext, StoredContextInput, StoredPlan, TodoInput, NoteInput } from './contracts.js';
import {
  isContextInput, isNoteInput, isTodoInput, isPlanInput, isOriginInput, isSessionInput, isSessionMapInput,
  isText, isBoolean, isTimestamp, hasErrorCode, isNoteSource, hasRandomUuid, PROJECT_CONTEXT_VERSION,
  PROJECT_NOTE_BODY_MAX_LENGTH, PROJECT_NOTE_MAX_ITEMS, PROJECT_TODO_TEXT_MAX_LENGTH, PROJECT_PLAN_TITLE_MAX_LENGTH,
  PROJECT_PLAN_BODY_MAX_LENGTH, PROJECT_TODO_MAX_ITEMS, PROJECT_PLAN_MAX_ITEMS, NOTES_TODOS_STORE_LOCAL,
  NOTES_TODOS_STORE_REPOSITORY, MALFORMED_NOTES_TODOS_FILE, PROJECT_ID_PATTERN, PLAN_FILE_PATTERN,
} from './contracts.js';
import type { PlanProgress } from './plan-progress.js';

const optionalTextInput = z.string().optional();
const completedInput = z.boolean();
const planIdInput = z.string().trim().min(1).nullable().optional();
const dependsOnInput = z.array(z.string().trim().min(1)).optional();

const clampLength = (value: string, maxLength: number) => value.length > maxLength ? value.slice(0, maxLength) : value;

const noteOriginInput = z.unknown().transform((value): NoteOrigin | null => {
  if (!isOriginInput(value)) return null;
  const sessionId = asNonEmptyString(value.sessionId);
  const messageId = asNonEmptyString(value.messageId);
  if (!sessionId) return null;
  return messageId ? { sessionId, messageId } : { sessionId };
});

const notesInput = z.tuple([z.unknown(), z.number()]).transform(([value, now]): ProjectNote[] => {
  if (isText(value)) {
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

  const result: ProjectNote[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (result.length >= PROJECT_NOTE_MAX_ITEMS) break;
    if (!isNoteInput(entry)) continue;
    const id = asNonEmptyString(entry.id);
    const body = clampLength(isText(entry.body) ? entry.body : '', PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!id || !body || seen.has(id)) continue;
    seen.add(id);

    const createdAt = isTimestamp(entry.createdAt) ? entry.createdAt : now;
    const origin = noteOriginInput.parse(entry.origin);
    const note: ProjectNote = {
      id,
      body,
      createdAt,
      updatedAt: isTimestamp(entry.updatedAt) ? entry.updatedAt : createdAt,
      source: isNoteSource(entry.source) ? entry.source : 'manual',
      pinned: entry.pinned === true,
    };
    if (origin) note.origin = origin;
    result.push(withLinks(note, { planId: asNonEmptyString(entry.planId) }));
  }

  return result.sort((a, b) => b.createdAt - a.createdAt);
});

const todosInput = z.tuple([z.unknown(), z.number()]).transform(([value, now]): ProjectTodo[] => {
  if (!Array.isArray(value)) return [];
  const result: ProjectTodo[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (result.length >= PROJECT_TODO_MAX_ITEMS) break;
    if (!isTodoInput(entry)) continue;
    const id = asNonEmptyString(entry.id);
    const text = clampLength(asNonEmptyString(entry.text) || '', PROJECT_TODO_TEXT_MAX_LENGTH);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    const dependsOn = Array.isArray(entry.dependsOn)
      ? [...new Set(entry.dependsOn.map(asNonEmptyString).filter((id) => id !== null))]
      : [];
    result.push(withLinks({
      id,
      text,
      completed: entry.completed === true,
      createdAt: isTimestamp(entry.createdAt) ? entry.createdAt : now,
    }, { planId: asNonEmptyString(entry.planId), dependsOn }));
  }
  return result;
});

const planTitleInput = z.unknown().transform((value) => clampLength(asNonEmptyString(value) || '', PROJECT_PLAN_TITLE_MAX_LENGTH));

export const parsePlanMarkdown = (raw: string) => {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const match = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (match) {
    return {
      title: planTitleInput.parse(match[1]) || 'Plan',
      body: normalized.slice(match[0].length).replace(/^\n+/, ''),
    };
  }
  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || 'Plan';
  return {
    title: planTitleInput.parse(firstLine.replace(/^#+\s*/, '')) || 'Plan',
    body: normalized.trim(),
  };
};

const formatPlanMarkdown = (title: string, body: string) => {
  const normalizedTitle = planTitleInput.parse(title) || 'Plan';
  const normalizedBody = body.trim();
  return normalizedBody ? `# ${normalizedTitle}\n\n${normalizedBody}` : `# ${normalizedTitle}\n`;
};

const slugifyPlanTitle = (value: string) => {
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

const planLinksInput = z.tuple([z.unknown(), z.number()]).transform(([value, now]): StoredPlan[] => {
  if (!Array.isArray(value)) return [];
  const result: StoredPlan[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  for (const entry of value) {
    if (result.length >= PROJECT_PLAN_MAX_ITEMS) break;
    if (!isPlanInput(entry)) continue;
    const id = asNonEmptyString(entry.id);
    const file = asNonEmptyString(entry.file);
    if (!id || !file || !PLAN_FILE_PATTERN.test(file)) continue;
    const shared = entry.shared === true;
    const fileKey = `${shared ? 'shared' : 'personal'}/${file}`;
    if (seenIds.has(id) || seenFiles.has(fileKey)) continue;
    seenIds.add(id);
    seenFiles.add(fileKey);
    result.push({
      id,
      file,
      title: planTitleInput.parse(entry.title) || 'Plan',
      createdAt: isTimestamp(entry.createdAt) ? entry.createdAt : now,
      pinned: entry.pinned === true,
      shared,
    });
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
});

const planSessionsInput = z.unknown().transform((value): PlanSessions => {
  if (!isSessionMapInput(value)) return {};
  const result: PlanSessions = {};
  const entries: [string, unknown][] = Object.entries(value);
  for (const [planId, entry] of entries.slice(0, PROJECT_PLAN_MAX_ITEMS)) {
    if (!asNonEmptyString(planId) || !isSessionInput(entry)) continue;
    const sessionId = asNonEmptyString(entry.sessionId);
    if (!sessionId) continue;
    result[planId] = {
      sessionId,
      linkedAt: isTimestamp(entry.linkedAt) ? entry.linkedAt : 0,
    };
  }
  return result;
});

const createEmptyContext = (): StoredContext => ({
  version: PROJECT_CONTEXT_VERSION,
  notes: [],
  todos: [],
  plans: [],
  planSessions: {},
});

const SHARED_PLAN_ID_PREFIX = 'shared:';

const mutationError = (message: string, status: number) => Object.assign(new Error(message), { status });

const withProgress = (plan: PublicPlan, progress: PlanProgress | null): PublicPlan => (progress ? { ...plan, progress } : plan);

const withoutKey = <T extends object>(record: T, key: keyof T): T => {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

const insertTodoBeforeCompleted = (items: ProjectTodo[], item: ProjectTodo) => {
  const firstCompletedIndex = items.findIndex((todo) => todo.completed);
  if (firstCompletedIndex === -1) return [...items, item];
  return [...items.slice(0, firstCompletedIndex), item, ...items.slice(firstCompletedIndex)];
};

const todoTextInput = z.unknown().transform((value) => {
  const text = asNonEmptyString(value);
  if (!text) throw mutationError('text is required', 400);
  if (text.length > PROJECT_TODO_TEXT_MAX_LENGTH) {
    throw mutationError(`text must be at most ${PROJECT_TODO_TEXT_MAX_LENGTH} characters`, 400);
  }
  return text;
});

const planIdPatch = z.unknown().transform((value) => {
  const planId = planIdInput.safeParse(value);
  if (!planId.success) throw mutationError('planId must be a non-empty string or null', 400);
  return planId.data;
});

const dependsOnPatch = z.unknown().transform((value) => {
  const dependsOn = dependsOnInput.safeParse(value);
  if (!dependsOn.success) throw mutationError('dependsOn must be an array of todo ids', 400);
  return dependsOn.data && [...new Set(dependsOn.data)];
});

const withLinks = <T extends object>(record: T, { planId, dependsOn }: { planId?: string | null | undefined; dependsOn?: string[] | undefined }): T & PlanLinks => {
  let next: T & PlanLinks = record;
  if (planId !== undefined) next = planId === null ? withoutKey(next, 'planId') : { ...next, planId };
  if (dependsOn !== undefined) next = dependsOn.length ? { ...next, dependsOn } : withoutKey(next, 'dependsOn');
  return next;
};

const withoutRemovedDependencies = (previous: ProjectTodo[], next: ProjectTodo[]) => {
  const kept = new Set(next.map((todo) => todo.id));
  const removed = new Set(previous.map((todo) => todo.id).filter((id) => !kept.has(id)));
  if (removed.size === 0) return next;
  return next.map((todo) => (todo.dependsOn?.some((id) => removed.has(id))
    ? withLinks(todo, { dependsOn: todo.dependsOn.filter((id) => !removed.has(id)) })
    : todo));
};

const withPlanUnlinked = <T extends StoredContext>(context: T, planId: string): T => {
  const linked = (entry: Pick<PlanLinks, 'planId'>) => entry.planId === planId;
  if (![...context.notes, ...context.todos].some(linked)) return context;
  return {
    ...context,
    notes: context.notes.map((note) => (linked(note) ? withLinks(note, { planId: null }) : note)),
    todos: context.todos.map((todo) => (linked(todo) ? withLinks(todo, { planId: null, dependsOn: [] }) : todo)),
  };
};

const assertTodoGraph = (previous: ProjectTodo[], next: ProjectTodo[]) => {
  const nextById = new Map(next.map((todo) => [todo.id, todo]));
  const previousById = new Map(previous.map((todo) => [todo.id, todo]));
  for (const todo of next) {
    for (const dependencyId of todo.dependsOn ?? []) {
      if (dependencyId === todo.id) throw mutationError('A todo cannot depend on itself', 400);
      const dependency = nextById.get(dependencyId);
      const before = previousById.get(todo.id);
      if (!dependency && !before?.dependsOn?.includes(dependencyId)) {
        throw mutationError(`Dependency ${dependencyId} not found`, 400);
      }
      const dependencyPlanId = dependency ? dependency.planId : before?.planId;
      if (!todo.planId || dependencyPlanId !== todo.planId) {
        throw mutationError('A dependency must link two todos of the same plan', 400);
      }
    }
  }
  const visited = new Map<string, 'done' | 'visiting'>();
  const visit = (todo: ProjectTodo) => {
    const id = todo.id;
    if (visited.get(id) === 'done') return;
    if (visited.get(id) === 'visiting') throw mutationError('Dependencies cannot form a cycle', 400);
    visited.set(id, 'visiting');
    for (const dependencyId of todo.dependsOn ?? []) {
      const dependency = nextById.get(dependencyId);
      if (dependency) visit(dependency);
    }
    visited.set(id, 'done');
  };
  for (const todo of next) visit(todo);
};

export const createProjectContextRuntime = (deps: ProjectContextDependencies) => {
  const { fsPromises, path, projectsDirPath, createId, resolveSharedPlansDir, resolveNotesTodosFile, onChanged } = deps;
  const sharedPlansDirFor = resolveSharedPlansDir ?? (async () => null);
  const resolveNotesTodosFileFor = resolveNotesTodosFile ?? (async () => null);

  const planSummaries = createPlanSummaryCache({ fsPromises, parseTitle: (raw) => parsePlanMarkdown(raw).title });

  const idFactory = createId ?? (() => (hasRandomUuid(globalThis.crypto)
    ? crypto.randomUUID()
    : `plan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`));

  const writeLocks = new Map<string, Promise<void>>();
  const lockedNotesTodosFiles = new Map<string, string | null>();
  const notesTodosSwitches = new Map<string, number>();
  const runPrefix = Math.random().toString(36).slice(2, 10);
  const notesTodosStoreToken = (projectId: string, store: 'local' | 'repository') => `${store}:${runPrefix}.${notesTodosSwitches.get(sanitizeProjectId(projectId)) ?? 0}`;

  const sanitizeProjectId = (projectId: string) => {
    const value = asNonEmptyString(projectId);
    if (!value) {
      throw new Error('projectId is required');
    }
    if (!PROJECT_ID_PATTERN.test(value)) {
      throw new Error('projectId contains unsupported characters');
    }
    return value;
  };

  const storageStemFor = (projectId: string): string => projectConfigFileStemOf(sanitizeProjectId(projectId));
  const storageDirFor = (projectId: string) => path.join(projectsDirPath, storageStemFor(projectId));
  const contextPathFor = (projectId: string) => path.join(storageDirFor(projectId), 'context.json');
  const plansDirFor = (projectId: string) => path.join(storageDirFor(projectId), 'plans');
  const legacyConfigPathFor = (projectId: string) => path.join(projectsDirPath, `${storageStemFor(projectId)}.json`);

  const readJson = async (filePath: string): Promise<{ missing: true; value: null } | { missing: false; value: StoredContextInput | null }> => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') return { missing: true, value: null };
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return { missing: false, value: isContextInput(parsed) ? parsed : null };
    } catch {
      return { missing: false, value: null };
    }
  };

  const writeJsonAtomic = async (filePath: string, value: StoredContextInput) => {
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

  const withWriteLock = async <T>(projectId: string, mutate: () => Promise<T>): Promise<T> => {
    const key = sanitizeProjectId(projectId);
    const previous = writeLocks.get(key) || Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.finally(() => next);
    writeLocks.set(key, chained);

    await previous;
    try {
      lockedNotesTodosFiles.set(key, await resolveNotesTodosFileFor(key));
      return await mutate();
    } finally {
      lockedNotesTodosFiles.delete(key);
      release();
      if (writeLocks.get(key) === chained) {
        writeLocks.delete(key);
      }
    }
  };

  const migrateFromLegacyConfig = async (projectId: string, now: number) => {
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
    const links: { id: string; file: string; title: string; createdAt: number }[] = [];
    const rawLinks = Array.isArray(legacy.value.projectPlanFiles) ? legacy.value.projectPlanFiles : [];
    for (const entry of rawLinks) {
      if (!isPlanInput(entry)) continue;
      const id = asNonEmptyString(entry.id);
      const absolutePath = asNonEmptyString(entry.path);
      if (!id || !absolutePath) continue;

      const file = path.basename(absolutePath);
      if (!PLAN_FILE_PATTERN.test(file)) continue;
      const targetPath = path.join(plansDir, file);

      let raw = null;
      try {
        raw = await fsPromises.readFile(targetPath, 'utf8');
      } catch (error) {
        if (!hasErrorCode(error) || error.code !== 'ENOENT') throw error;
        try {
          raw = await fsPromises.readFile(absolutePath, 'utf8');
        } catch (recoverError) {
          if (!hasErrorCode(recoverError) || recoverError.code !== 'ENOENT') throw recoverError;
          continue;
        }
        await fsPromises.mkdir(plansDir, { recursive: true });
        await fsPromises.writeFile(targetPath, raw, 'utf8');
      }

      links.push({
        id,
        file,
        title: parsePlanMarkdown(raw).title,
        createdAt: isTimestamp(entry.createdAt) ? entry.createdAt : now,
      });
    }

    const migrated = {
      version: PROJECT_CONTEXT_VERSION,
      notes: notesInput.parse([legacy.value.projectNotes, now]),
      todos: todosInput.parse([legacy.value.projectTodos, now]),
      plans: planLinksInput.parse([links, now]),
    };

    await writeJsonAtomic(contextPathFor(projectId), migrated);

    const remaining = { ...legacy.value };
    delete remaining.projectNotes;
    delete remaining.projectTodos;
    delete remaining.projectPlanFiles;
    await writeJsonAtomic(legacyPath, remaining);

    return migrated;
  };

  const notesTodosFileFor = async (projectId: string) => {
    const key = sanitizeProjectId(projectId);
    return lockedNotesTodosFiles.has(key) ? lockedNotesTodosFiles.get(key) : resolveNotesTodosFileFor(key);
  };

  const readNotesTodosFile = async (filePath: string, now: number): Promise<NotesTodos> => {
    const stored = await readJson(filePath);
    if (stored.missing) return { notes: [], todos: [] };
    const isList = (value: unknown): value is unknown[] | undefined => value === undefined || Array.isArray(value);
    if (!stored.value || !isList(stored.value.notes) || !isList(stored.value.todos)) {
      throw Object.assign(new Error(`Notes and todos file ${filePath} is malformed`), { code: MALFORMED_NOTES_TODOS_FILE });
    }
    return { notes: notesInput.parse([stored.value.notes, now]), todos: todosInput.parse([stored.value.todos, now]) };
  };

  const readLocalContext = async (projectId: string): Promise<StoredContext> => {
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
          notes: notesInput.parse([migrated.notes, now]),
          todos: todosInput.parse([migrated.todos, now]),
          plans: planLinksInput.parse([migrated.plans, now]),
          planSessions: {},
        };
      }
      return createEmptyContext();
    }

    return {
      version: PROJECT_CONTEXT_VERSION,
      notes: notesInput.parse([stored.value?.notes, now]),
      todos: todosInput.parse([stored.value?.todos, now]),
      plans: planLinksInput.parse([stored.value?.plans, now]),
      planSessions: planSessionsInput.parse(stored.value?.planSessions),
    };
  };

  const readStoredContext = async (projectId: string) => {
    const local = await readLocalContext(projectId);
    const notesTodosFile = await notesTodosFileFor(projectId);
    if (!notesTodosFile) return { ...local, notesTodosStore: notesTodosStoreToken(projectId, NOTES_TODOS_STORE_LOCAL) };
    return {
      ...local,
      ...(await readNotesTodosFile(notesTodosFile, Date.now())),
      notesTodosStore: notesTodosStoreToken(projectId, NOTES_TODOS_STORE_REPOSITORY),
    };
  };

  const sharedPlanFileOf = (planId: string) => {
    if (!planId.startsWith(SHARED_PLAN_ID_PREFIX)) return null;
    const file = planId.slice(SHARED_PLAN_ID_PREFIX.length);
    return PLAN_FILE_PATTERN.test(file) ? file : null;
  };

  const listSharedPlans = async (projectId: string, claimedFiles = new Set<string>()) => {
    const dir = await sharedPlansDirFor(projectId);
    if (!dir) return { dir: null, plans: [] };
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') return { dir, plans: [] };
      throw error;
    }
    const plans: PublicPlan[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !PLAN_FILE_PATTERN.test(entry.name)) continue;
      if (claimedFiles.has(entry.name)) continue;
      const summary = await planSummaries.summaryOf(path.join(dir, entry.name));
      if (!summary) continue;
      plans.push(withProgress({
        id: `${SHARED_PLAN_ID_PREFIX}${entry.name}`,
        file: entry.name,
        title: summary.title,
        createdAt: Math.round(summary.mtimeMs),
        pinned: false,
        source: 'shared',
      }, summary.progress));
    }
    plans.sort((left, right) => right.createdAt - left.createdAt);
    return { dir, plans };
  };

  const progressOfLink = async (projectId: string, link: Pick<StoredPlan, 'file'> & { shared: boolean | undefined }, sharedDir: string | null) => {
    const folder = link.shared ? sharedDir : plansDirFor(projectId);
    if (!folder) return null;
    try {
      return (await planSummaries.summaryOf(path.join(folder, link.file)))?.progress ?? null;
    } catch {
      return null;
    }
  };

  const readContext = async (projectId: string): Promise<ProjectContext> => {
    const { planSessions, ...stored } = await readStoredContext(projectId);
    const claimed = new Set(stored.plans.filter((plan) => plan.shared).map((plan) => plan.file));
    const shared = await listSharedPlans(projectId, claimed);
    const own = await Promise.all(stored.plans
      .filter((plan) => !plan.shared || shared.dir)
      .map(async ({ shared: isShared, ...plan }) => {
        const progress = await progressOfLink(projectId, { ...plan, shared: isShared }, shared.dir);
        return withProgress({ ...plan, source: isShared ? 'shared' : 'personal' }, progress);
      }));
    const withSession = (plan: PublicPlan): PublicPlan => {
      const session = planSessions[plan.id];
      return session ? { ...plan, session } : plan;
    };
    return {
      ...stored,
      plans: [...own, ...shared.plans].map(withSession),
      sharedPlansDir: shared.dir,
    };
  };

  const publicPlanOf = async (projectId: string, planId: string) => {
    const context = await readContext(projectId);
    return { plan: context.plans.find((entry) => entry.id === planId) ?? null, context };
  };

  const folderOfLink = async (projectId: string, link: StoredPlan) => (link.shared ? sharedPlansDirFor(projectId) : plansDirFor(projectId));

  const writeContext = async (projectId: string, context: StoredContext) => {
    const local = {
      version: PROJECT_CONTEXT_VERSION,
      notes: context.notes,
      todos: context.todos,
      plans: context.plans,
      planSessions: context.planSessions ?? {},
    };
    const notesTodosFile = await notesTodosFileFor(projectId);
    if (!notesTodosFile) {
      await writeJsonAtomic(contextPathFor(projectId), local);
      onChanged?.(sanitizeProjectId(projectId));
      return;
    }
    const now = Date.now();
    const kept = (await readJson(contextPathFor(projectId))).value ?? {};
    const keptPlans = { plans: planLinksInput.parse([kept.plans, now]), planSessions: planSessionsInput.parse(kept.planSessions) };
    if (JSON.stringify(keptPlans) !== JSON.stringify({ plans: local.plans, planSessions: local.planSessions })) {
      await writeJsonAtomic(contextPathFor(projectId), { ...local, notes: kept.notes ?? [], todos: kept.todos ?? [] });
    }
    const next = { notes: context.notes, todos: context.todos };
    if (JSON.stringify(await readNotesTodosFile(notesTodosFile, now)) !== JSON.stringify(next)) {
      await writeJsonAtomic(notesTodosFile, { version: 1, ...next });
    }
    onChanged?.(sanitizeProjectId(projectId));
  };

  const planExists = async (projectId: string, current: StoredContext, planId: string) => {
    const sharedFile = sharedPlanFileOf(planId);
    if (!sharedFile) return current.plans.some((entry) => entry.id === planId);
    const dir = await sharedPlansDirFor(projectId);
    return dir ? fsPromises.access(path.join(dir, sharedFile)).then(() => true, () => false) : false;
  };

  const assertNewPlanLinksExist = async (projectId: string, current: StoredContext, previous: (PlanLinks & { id: string })[], next: (PlanLinks & { id: string })[]) => {
    const previousById = new Map(previous.map((entry) => [entry.id, entry]));
    const checked = new Set<string>();
    for (const { id, planId } of next) {
      if (!planId || planId === previousById.get(id)?.planId || checked.has(planId)) continue;
      if (!await planExists(projectId, current, planId)) throw mutationError(`Plan ${planId} not found`, 400);
      checked.add(planId);
    }
  };

  const assertTodosWrite = async (projectId: string, current: StoredContext, todos: ProjectTodo[]) => {
    assertTodoGraph(current.todos, todos);
    await assertNewPlanLinksExist(projectId, current, current.todos, todos);
  };

  const saveTodos = async (projectId: string, todos: TodoInput[], { store }: { store?: string | undefined } = {}) => {
    const entries = Array.isArray(todos) ? todos : [];
    for (const entry of entries) {
      planIdPatch.parse(entry?.planId);
      dependsOnPatch.parse(entry?.dependsOn);
    }
    return withWriteLock(projectId, async () => {
      const now = Date.now();
      const current = await readStoredContext(projectId);
      if (store !== undefined && store !== current.notesTodosStore) {
        throw mutationError('Notes and todos moved to another store; reload the list', 409);
      }
      const stored = new Map(current.todos.map((todo) => [todo.id, todo]));
      const merged = entries.map((entry) => {
        const entryId = isTodoInput(entry) ? asNonEmptyString(entry.id) : null;
        const existing = entryId ? stored.get(entryId) : undefined;
        if (!existing) return entry;
        return {
          ...entry,
          planId: entry.planId === undefined ? existing.planId : entry.planId,
          dependsOn: entry.dependsOn === undefined ? existing.dependsOn : entry.dependsOn,
        };
      });
      const next = { ...current, todos: withoutRemovedDependencies(current.todos, todosInput.parse([merged, now])) };
      await assertTodosWrite(projectId, current, next.todos);
      await writeContext(projectId, next);
      return next;
    });
  };

  const createTodo = async (projectId: string, value: TodoInput) => {
    const text = todoTextInput.parse(value?.text);
    const requestedId = asNonEmptyString(value?.id);
    const links = { planId: planIdPatch.parse(value?.planId), dependsOn: dependsOnPatch.parse(value?.dependsOn) };
    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (current.todos.length >= PROJECT_TODO_MAX_ITEMS) {
        throw mutationError(`A project can hold at most ${PROJECT_TODO_MAX_ITEMS} todos`, 400);
      }
      const id = requestedId && !current.todos.some((todo) => todo.id === requestedId) ? requestedId : idFactory();
      const todo = withLinks({ id, text, completed: value?.completed === true, createdAt: Date.now() }, links);
      const next = { ...current, todos: todo.completed ? [...current.todos, todo] : insertTodoBeforeCompleted(current.todos, todo) };
      await assertTodosWrite(projectId, current, next.todos);
      await writeContext(projectId, next);
      return { todo, context: next };
    });
  };

  const updateTodo = async (projectId: string, todoId: string, patch: TodoInput) => {
    const id = asNonEmptyString(todoId);
    if (!id) throw mutationError('todoId is required', 400);
    const hasText = patch?.text !== undefined;
    const hasCompleted = patch?.completed !== undefined;
    const links = { planId: planIdPatch.parse(patch?.planId), dependsOn: dependsOnPatch.parse(patch?.dependsOn) };
    if (!hasText && !hasCompleted && links.planId === undefined && links.dependsOn === undefined) {
      throw mutationError('text, completed, planId or dependsOn is required', 400);
    }
    const text = hasText ? todoTextInput.parse(patch.text) : null;
    const completed = completedInput.safeParse(patch?.completed);
    if (hasCompleted && !completed.success) {
      throw mutationError('completed must be a boolean', 400);
    }
    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const existing = current.todos.find((todo) => todo.id === id);
      if (!existing) throw mutationError('Todo not found', 404);
      const updated = withLinks({ ...existing }, links);
      if (text !== null) updated.text = text;
      if (hasCompleted && completed.success) updated.completed = completed.data;
      let todos;
      if (updated.completed !== existing.completed) {
        const remaining = current.todos.filter((todo) => todo.id !== id);
        todos = updated.completed ? [...remaining, updated] : insertTodoBeforeCompleted(remaining, updated);
      } else {
        todos = current.todos.map((todo) => todo.id === id ? updated : todo);
      }
      const next = { ...current, todos };
      await assertTodosWrite(projectId, current, todos);
      await writeContext(projectId, next);
      return next;
    });
  };

  const deleteTodo = async (projectId: string, todoId: string) => {
    const id = asNonEmptyString(todoId);
    if (!id) throw mutationError('todoId is required', 400);
    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (!current.todos.some((todo) => todo.id === id)) throw mutationError('Todo not found', 404);
      const next = { ...current, todos: withoutRemovedDependencies(current.todos, current.todos.filter((todo) => todo.id !== id)) };
      await writeContext(projectId, next);
      return next;
    });
  };

  const createNote = async (projectId: string, value: NoteInput) => {
    const body = clampLength(isText(value?.body) ? value.body : '', PROJECT_NOTE_BODY_MAX_LENGTH).trim();
    if (!body) {
      throw new Error('body is required');
    }
    const planId = planIdPatch.parse(value?.planId);

    return withWriteLock(projectId, async () => {
      const now = Date.now();
      const current = await readStoredContext(projectId);
      if (current.notes.length >= PROJECT_NOTE_MAX_ITEMS) {
        throw mutationError(`A project can hold at most ${PROJECT_NOTE_MAX_ITEMS} notes`, 400);
      }

      const origin = noteOriginInput.parse(value?.origin);
      const noteValue: ProjectNote = {
        id: idFactory(),
        body,
        createdAt: now,
        updatedAt: now,
        source: isNoteSource(value?.source) ? value.source : 'manual',
        pinned: false,
      };
      if (origin) noteValue.origin = origin;
      const note = withLinks(noteValue, { planId });

      const next = { ...current, notes: [note, ...current.notes] };
      await assertNewPlanLinksExist(projectId, current, current.notes, [note]);
      await writeContext(projectId, next);
      return { note, context: next };
    });
  };

  const updateNote = async (projectId: string, noteId: string, patch: NoteInput, options: { expectedBody?: unknown } = {}) => {
    const id = asNonEmptyString(noteId);
    if (!id) {
      throw new Error('noteId is required');
    }
    const patchBody = patch?.body;
    const patchPinned = patch?.pinned;
    const hasBody = isText(patchBody);
    const hasPinned = isBoolean(patchPinned);
    const planId = planIdPatch.parse(patch?.planId);
    if (!hasBody && !hasPinned && planId === undefined) {
      throw new Error('body, pinned or planId is required');
    }
    const body = hasBody ? clampLength(patchBody, PROJECT_NOTE_BODY_MAX_LENGTH).trim() : null;
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

      const noteValue = { ...existing };
      if (body !== null) {
        noteValue.body = body;
        noteValue.updatedAt = now;
      }
      if (hasPinned) noteValue.pinned = patchPinned;
      const note = withLinks(noteValue, { planId });
      const next = { ...current, notes: current.notes.map((entry) => (entry.id === id ? note : entry)) };
      await assertNewPlanLinksExist(projectId, current, current.notes, [note]);
      await writeContext(projectId, next);
      return { note, context: next };
    });
  };

  const deleteNote = async (projectId: string, noteId: string) => {
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

  const readPlan = async (projectId: string, planId: string): Promise<ReadPlan | null> => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }
    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir) return null;
      const planPath = path.join(dir, sharedFile);
      let raw;
      try {
        raw = await fsPromises.readFile(planPath, 'utf8');
      } catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') return null;
        throw error;
      }
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
    let raw;
    try {
      raw = await fsPromises.readFile(planPath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') return null;
      throw error;
    }

    const parsed = parsePlanMarkdown(raw);
    return { id: link.id, file: link.file, path: planPath, createdAt: link.createdAt, title: parsed.title, body: parsed.body, raw, source: link.shared ? 'shared' : 'personal' };
  };

  const updatePlan = async (projectId: string, planId: string, value: PlanInput, options: { expectedRaw?: unknown } = {}) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }
    if (!isText(value?.raw)) {
      throw new Error('raw is required');
    }
    const expectedRaw = optionalTextInput.safeParse(options.expectedRaw);
    if (!expectedRaw.success) {
      throw mutationError('expectedRaw must be a string', 400);
    }
    const raw = clampLength(value.raw, PROJECT_PLAN_BODY_MAX_LENGTH);
    const checkExpectedRaw = async (filePath: string) => {
      if (expectedRaw.data !== undefined
        && await fsPromises.readFile(filePath, 'utf8') !== expectedRaw.data) {
        throw mutationError('Plan changed; reload before saving', 409);
      }
    };

    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      return withWriteLock(projectId, async () => {
        const dir = await sharedPlansDirFor(projectId);
        if (!dir) return null;
        const filePath = path.join(dir, sharedFile);
        try {
          await fsPromises.access(filePath);
        } catch (error) {
          if (hasErrorCode(error) && error.code === 'ENOENT') return null;
          throw error;
        }
        await checkExpectedRaw(filePath);
        await fsPromises.writeFile(filePath, raw, 'utf8');
        onChanged?.(sanitizeProjectId(projectId));
        const parsed = parsePlanMarkdown(raw);
        const context = await readContext(projectId);
        const plan: PublicPlan = context.plans.find((entry) => entry.id === id) ?? { id, file: sharedFile, title: parsed.title, createdAt: Date.now(), pinned: false, source: 'shared' };
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
      try {
        await fsPromises.access(filePath);
      } catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') return null;
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
      return { plan: plan ?? ({ ...publicLink, source: isShared ? 'shared' : 'personal' } satisfies PublicPlan), context, title: parsed.title, body: parsed.body, raw };
    });
  };

  const createPlan = async (projectId: string, value: PlanInput) => {
    const title = planTitleInput.parse(value?.title) || 'Plan';
    const body = clampLength(isText(value?.body) ? value.body : '', PROJECT_PLAN_BODY_MAX_LENGTH);

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
      return { plan: plan ?? ({ ...link, source: 'personal' } satisfies PublicPlan), context };
    });
  };

  const setPlanPinned = async (projectId: string, planId: string, pinned: boolean) => {
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
      return { plan: committed.plan ?? ({ ...publicPlan, source: isShared ? 'shared' : 'personal' } satisfies PublicPlan), context: committed.context };
    });
  };

  const deletePlan = async (projectId: string, planId: string) => {
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
        if (!exists || filePath === null) return { deleted: false, context: await readContext(projectId) };
        const current = await readStoredContext(projectId);
        await fsPromises.rm(filePath, { force: true });
        const next = withPlanUnlinked(current, id);
        if (current.planSessions[id] || next !== current) {
          await writeContext(projectId, { ...next, planSessions: withoutKey(current.planSessions, id) });
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
      const unlinked = withPlanUnlinked(current, id);
      if (unlinked !== current && await notesTodosFileFor(projectId)) {
        await writeContext(projectId, unlinked);
      }
      const next = {
        ...unlinked,
        plans: current.plans.filter((entry) => entry.id !== id),
        planSessions: withoutKey(current.planSessions, id),
      };
      await writeContext(projectId, next);
      const folder = await folderOfLink(projectId, link);
      if (folder) await fsPromises.rm(path.join(folder, link.file), { force: true });
      return { deleted: true, context: await readContext(projectId) };
    });
  };

  const freeFileNameIn = async (dir: string, wanted: string, taken = new Set<string>()) => {
    const base = wanted.replace(/\.md$/, '');
    let file = wanted;
    let attempt = 1;
    while (taken.has(file) || await fsPromises.access(path.join(dir, file)).then(() => true, () => false)) {
      file = `${base}-${attempt}.md`;
      attempt += 1;
    }
    return file;
  };

  const moveFile = async (from: string, to: string) => {
    try {
      await fsPromises.rename(from, to);
    } catch (error) {
      if (!hasErrorCode(error) || error.code !== 'EXDEV') throw error;
      await fsPromises.copyFile(from, to);
      await fsPromises.rm(from, { force: true });
    }
  };

  const sharePlan = async (projectId: string, planId: string) => {
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

  const unsharePlan = async (projectId: string, planId: string) => {
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
      let raw;
      try {
        raw = await fsPromises.readFile(from, 'utf8');
      } catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') return null;
        throw error;
      }
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
      const session = current.planSessions[id];
      const planSessions = !ownLink && session
        ? { ...withoutKey(current.planSessions, id), [link.id]: session }
        : current.planSessions;
      const relink = <T extends PlanLinks>(entry: T): T => (!ownLink && entry.planId === id ? { ...entry, planId: link.id } : entry);
      await writeContext(projectId, {
        ...current,
        notes: current.notes.map(relink),
        todos: current.todos.map(relink),
        plans,
        planSessions,
      });
      const { shared: _movedFlag, ...publicLink } = link;
      const committed = await publicPlanOf(projectId, link.id);
      return { plan: committed.plan ?? ({ ...publicLink, source: 'personal' } satisfies PublicPlan), context: committed.context };
    });
  };

  const setPlanSession = async (projectId: string, planId: string, value: { sessionId?: unknown }) => {
    const id = asNonEmptyString(planId);
    if (!id) throw new Error('planId is required');
    const clear = value?.sessionId === null;
    const sessionId = asNonEmptyString(value?.sessionId);
    if (!clear && !sessionId) throw mutationError('sessionId is required', 400);

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      if (!await planExists(projectId, current, id)) return null;
      if (clear && !current.planSessions[id]) return publicPlanOf(projectId, id);
      await writeContext(projectId, {
        ...current,
        planSessions: clear || sessionId === null
          ? withoutKey(current.planSessions, id)
          : { ...current.planSessions, [id]: { sessionId, linkedAt: Date.now() } },
      });
      return publicPlanOf(projectId, id);
    });
  };

  const mergeById = <T extends { id: string }>(into: T[], from: T[]) => {
    const fromById = new Map(from.map((entry) => [entry.id, entry]));
    const ids = new Set(into.map((entry) => entry.id));
    return [...into.map((entry) => fromById.get(entry.id) ?? entry), ...from.filter((entry) => !ids.has(entry.id))];
  };

  const switchNotesTodosStorage = async (projectId: string, { enabled, file, commit }: StorageSwitch) => withWriteLock(projectId, async () => {
    const key = sanitizeProjectId(projectId);
    if (enabled && !file) throw new Error('project checkout not found');
    if (Boolean(lockedNotesTodosFiles.get(key)) === enabled) {
      await commit();
      return;
    }
    const now = Date.now();
    const local = await readLocalContext(projectId);
    const empty = { notes: [], todos: [] };
    const repository = !file ? empty : await readNotesTodosFile(file, now).catch((error) => {
      if (!enabled && hasErrorCode(error) && error.code === MALFORMED_NOTES_TODOS_FILE) return empty;
      throw error;
    });
    const [from, into]: [NotesTodos, NotesTodos] = enabled ? [local, repository] : [repository, local];
    const merged = { notes: mergeById(into.notes, from.notes), todos: mergeById(into.todos, from.todos) };
    if (merged.notes.length > PROJECT_NOTE_MAX_ITEMS || merged.todos.length > PROJECT_TODO_MAX_ITEMS) {
      throw mutationError(`Together they exceed ${PROJECT_NOTE_MAX_ITEMS} notes or ${PROJECT_TODO_MAX_ITEMS} todos`, 400);
    }
    const writeLocal = (entries: NotesTodos) => writeJsonAtomic(contextPathFor(projectId), {
      version: PROJECT_CONTEXT_VERSION,
      ...entries,
      plans: local.plans,
      planSessions: local.planSessions ?? {},
    });
    const commitSwitch = async () => {
      await commit();
      notesTodosSwitches.set(key, (notesTodosSwitches.get(key) ?? 0) + 1);
    };
    if (!enabled) {
      await writeLocal(merged);
      await commitSwitch();
      onChanged?.(key);
      return;
    }
    if (file !== null && JSON.stringify(repository) !== JSON.stringify(merged)) {
      await writeJsonAtomic(file, { version: 1, ...merged });
    }
    await commitSwitch();
    try {
      if (local.notes.length > 0 || local.todos.length > 0) await writeLocal({ notes: [], todos: [] });
    } finally {
      onChanged?.(key);
    }
  });

  return {
    readContext,
    switchNotesTodosStorage,
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
