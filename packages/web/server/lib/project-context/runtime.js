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

const PROJECT_CONTEXT_VERSION = 2;
const PROJECT_NOTE_BODY_MAX_LENGTH = 3000;
const PROJECT_NOTE_MAX_ITEMS = 200;
const PROJECT_TODO_TEXT_MAX_LENGTH = 120;
const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;
const PROJECT_PLAN_BODY_MAX_LENGTH = 200_000;
const PROJECT_TODO_MAX_ITEMS = 500;
const PROJECT_PLAN_MAX_ITEMS = 500;

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const PLAN_FILE_PATTERN = /^[a-zA-Z0-9._-]+\.md$/;

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
    if (!id || !text || seen.has(id)) continue;
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

const createEmptyContext = () => ({
  version: PROJECT_CONTEXT_VERSION,
  notes: [],
  todos: [],
  plans: [],
});

const SHARED_PLAN_ID_PREFIX = 'shared:';

export const createProjectContextRuntime = (deps) => {
  const { fsPromises, path, projectsDirPath, createId, resolveSharedPlansDir } = deps;
  // The team's shared plans folder for a project (absolute path) or null; the
  // project config runtime owns that answer (`plansDir` in the shared file).
  const sharedPlansDirFor = typeof resolveSharedPlansDir === 'function'
    ? resolveSharedPlansDir
    : async () => null;

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

  const storageDirFor = (projectId) => path.join(projectsDirPath, sanitizeProjectId(projectId));
  const contextPathFor = (projectId) => path.join(storageDirFor(projectId), 'context.json');
  const plansDirFor = (projectId) => path.join(storageDirFor(projectId), 'plans');
  const legacyConfigPathFor = (projectId) => path.join(projectsDirPath, `${sanitizeProjectId(projectId)}.json`);

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
        raw = await fsPromises.readFile(targetPath, 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        // Not in the plans directory yet — recover it from the recorded path.
        try {
          raw = await fsPromises.readFile(absolutePath, 'utf8');
        } catch (recoverError) {
          if (!recoverError || recoverError.code !== 'ENOENT') throw recoverError;
          continue;
        }
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
        };
      }
      return createEmptyContext();
    }

    return {
      version: PROJECT_CONTEXT_VERSION,
      notes: sanitizeNotes(stored.value.notes, now),
      todos: sanitizeTodos(stored.value.todos, now),
      plans: sanitizePlanLinks(stored.value.plans, now),
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
      const filePath = path.join(dir, entry.name);
      const [raw, stat] = await Promise.all([fsPromises.readFile(filePath, 'utf8'), fsPromises.stat(filePath)]);
      plans.push({
        id: `${SHARED_PLAN_ID_PREFIX}${entry.name}`,
        file: entry.name,
        title: parsePlanMarkdown(raw).title,
        createdAt: Math.round(stat.mtimeMs),
        pinned: false,
        source: 'shared',
      });
    }
    plans.sort((left, right) => right.createdAt - left.createdAt);
    return { dir, plans };
  };

  /** What clients see: the stored context plus the team's shared plans, each marked with its source. */
  const readContext = async (projectId) => {
    const stored = await readStoredContext(projectId);
    const claimed = new Set(stored.plans.filter((plan) => plan.shared).map((plan) => plan.file));
    const shared = await listSharedPlans(projectId, claimed);
    const own = stored.plans
      // A moved plan is only reachable while the project still has a shared folder.
      .filter((plan) => !plan.shared || shared.dir)
      .map(({ shared: isShared, ...plan }) => ({ ...plan, source: isShared ? 'shared' : 'personal' }));
    return {
      ...stored,
      plans: [...own, ...shared.plans],
      sharedPlansDir: shared.dir,
    };
  };

  /** The folder a manifest plan's file lives in; null for a moved plan when the project lost its shared folder. */
  const folderOfLink = async (projectId, link) => (link.shared ? sharedPlansDirFor(projectId) : plansDirFor(projectId));

  const writeContext = async (projectId, context) => {
    await writeJsonAtomic(contextPathFor(projectId), {
      version: PROJECT_CONTEXT_VERSION,
      notes: context.notes,
      todos: context.todos,
      plans: context.plans,
    });
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
        throw new Error(`A project can hold at most ${PROJECT_NOTE_MAX_ITEMS} notes`);
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
  const updateNote = async (projectId, noteId, patch) => {
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

    return withWriteLock(projectId, async () => {
      const now = Date.now();
      const current = await readStoredContext(projectId);
      const existing = current.notes.find((note) => note.id === id);
      if (!existing) {
        return null;
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

  const readPlan = async (projectId, planId) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }
    const sharedFile = sharedPlanFileOf(id);
    if (sharedFile) {
      const dir = await sharedPlansDirFor(projectId);
      if (!dir) return null;
      let raw;
      try {
        raw = await fsPromises.readFile(path.join(dir, sharedFile), 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
      const parsed = parsePlanMarkdown(raw);
      return { id, file: sharedFile, createdAt: 0, title: parsed.title, body: parsed.body, raw, source: 'shared' };
    }
    const context = await readStoredContext(projectId);
    const link = context.plans.find((entry) => entry.id === id);
    if (!link) {
      return null;
    }

    const folder = await folderOfLink(projectId, link);
    if (!folder) return null;
    let raw;
    try {
      raw = await fsPromises.readFile(path.join(folder, link.file), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }

    const parsed = parsePlanMarkdown(raw);
    return { id: link.id, file: link.file, createdAt: link.createdAt, title: parsed.title, body: parsed.body, raw, source: link.shared ? 'shared' : 'personal' };
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
  const updatePlan = async (projectId, planId, value) => {
    const id = asNonEmptyString(planId);
    if (!id) {
      throw new Error('planId is required');
    }
    if (typeof value?.raw !== 'string') {
      throw new Error('raw is required');
    }
    const raw = clampLength(value.raw, PROJECT_PLAN_BODY_MAX_LENGTH);

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
        await fsPromises.writeFile(filePath, raw, 'utf8');
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

      await fsPromises.writeFile(filePath, raw, 'utf8');

      const parsed = parsePlanMarkdown(raw);
      const nextLink = { ...link, title: parsed.title };
      const next = {
        ...current,
        plans: current.plans.map((entry) => (entry.id === id ? nextLink : entry)),
      };
      await writeContext(projectId, next);

      const { shared: isShared, ...publicLink } = nextLink;
      return { plan: { ...publicLink, source: isShared ? 'shared' : 'personal' }, context: await readContext(projectId), title: parsed.title, body: parsed.body, raw };
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
      return { plan: { ...link, source: 'personal' }, context: await readContext(projectId) };
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
      const { shared: isShared, ...publicPlan } = plan;
      return { plan: { ...publicPlan, source: isShared ? 'shared' : 'personal' }, context: await readContext(projectId) };
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
        return { deleted: true, context: await readContext(projectId) };
      });
    }

    return withWriteLock(projectId, async () => {
      const current = await readStoredContext(projectId);
      const link = current.plans.find((entry) => entry.id === id);
      if (!link) {
        return { deleted: false, context: await readContext(projectId) };
      }

      const next = { ...current, plans: current.plans.filter((entry) => entry.id !== id) };
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
      let raw;
      try {
        raw = await fsPromises.readFile(from, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
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
      await writeContext(projectId, { ...current, plans });
      const { shared: _movedFlag, ...publicLink } = link;
      return { plan: { ...publicLink, source: 'personal' }, context: await readContext(projectId) };
    });
  };

  return {
    readContext,
    saveTodos,
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
