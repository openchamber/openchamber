import path from 'node:path';
import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';
import { parsePlanMarkdown } from '../project-context/runtime.js';
import { parsePlanProgress } from '../project-context/plan-progress.js';
import { OpenChamberControlError } from './error.js';

const stringInput = z.string();
const completedInput = z.boolean();
const kindInput = z.enum(['note', 'todo', 'plan']);

const NOTE_MAX_LENGTH = 3000;
const TODO_MAX_LENGTH = 1000;
const PLAN_MAX_LENGTH = 200_000;

const requiredString = (input, field, maxLength, allowEmpty = false) => {
  const parsed = stringInput.safeParse(input[field]);
  if (!parsed.success || (!allowEmpty && !parsed.data.trim())) {
    throw new OpenChamberControlError(`${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`, 400);
  }
  const value = parsed.data;
  if (maxLength && value.length > maxLength) {
    throw new OpenChamberControlError(`${field} must be at most ${maxLength} characters`, 400);
  }
  return value;
};

const kindOf = (input, allowed) => {
  const parsed = kindInput.safeParse(input.kind);
  if (!parsed.success || !allowed.includes(parsed.data)) {
    throw new OpenChamberControlError(`kind must be ${allowed.join(', ')}`, 400);
  }
  return parsed.data;
};

const idOf = (input) => requiredString(input, 'id').trim();

const found = (value, kind, id) => {
  if (!value) throw new OpenChamberControlError(`${kind} not found: ${id}`, 404);
  return value;
};

const completedOf = (input) => {
  if (input.completed === undefined) return undefined;
  const completed = completedInput.safeParse(input.completed);
  if (!completed.success) throw new OpenChamberControlError('completed must be a boolean', 400);
  return completed.data;
};

/** `expected` guards notes and plans only: a todo write names its one field. */
const expectedOf = (input) => (input.expected === undefined ? undefined : requiredString(input, 'expected', undefined, true));

/**
 * `expected` compares a replacement against the text the caller read. A create
 * has nothing to compare against, and silently ignoring it would let an agent
 * believe a conflict check ran, so it is refused before anything is written.
 */
const rejectExpectedOnCreate = (input) => {
  if (input.expected !== undefined && input.id === undefined) {
    throw new OpenChamberControlError('expected requires an id: pass the id of the note or plan you are replacing, or leave expected out to create', 400);
  }
};

/**
 * The `openchamber_knowledge` actions over the server-owned knowledge store.
 * Four verbs, with `kind` naming notes, todos or plans. Reading and small
 * edits of a plan go through the agent's file tools on the path list gives.
 */
export const createProjectKnowledgeActions = ({ projectContextRuntime: runtime, resolveProjectContextId, isEnabled, resolveDirectory, showPlan }) => {
  const ownerOf = async (input, contextDirectory) => {
    for (const field of ['projectId', 'directory']) {
      if (input[field] !== undefined) requiredString(input, field);
    }
    if (input.projectId !== undefined && input.directory !== undefined) {
      throw new OpenChamberControlError('Provide only one of projectId or directory', 400);
    }
    const directory = input.projectId !== undefined
      ? await resolveDirectory({ projectId: input.projectId.trim() })
      : (asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory));
    if (!directory || !path.isAbsolute(directory)) {
      throw new OpenChamberControlError('An absolute project or calling-session directory is required', 400);
    }
    const projectId = asNonEmptyString(await resolveProjectContextId(directory));
    if (!projectId) throw new OpenChamberControlError('Project context owner not found', 404);
    return { projectId, directory };
  };

  // A plan is a markdown file: the agent reads and edits it with its own file
  // tools, so the knowledge tool hands out where it lives, never its text.
  const planEntry = ({ id, title, source, createdAt, progress }, filePath) => {
    const entry = { id, title, source, createdAt, path: filePath };
    if (progress) entry.progress = progress;
    return entry;
  };

  /**
   * The panel shows a plan's progress from its `## Steps` checklist, so a plan
   * saved without one is answered with a warning the agent can act on in the
   * same turn rather than a plan whose progress nobody can see.
   */
  const withStepsCheck = (result, body) => (parsePlanProgress(body)
    ? result
    : { ...result, warning: 'This plan has no "## Steps" checklist ("- [ ] step" lines under a "## Steps" heading), so its progress cannot be shown. Add one with the plan\'s coarse steps.' });

  const list = async (projectId) => {
    const context = await runtime.readContext(projectId);
    const personalDir = runtime.plansDirFor(projectId);
    return {
      projectId,
      notes: context.notes,
      todos: context.todos,
      plans: context.plans
        .map((plan) => {
          const dir = plan.source === 'shared' ? context.sharedPlansDir : personalDir;
          return dir ? planEntry(plan, path.join(dir, plan.file)) : null;
        })
        .filter(Boolean),
    };
  };

  const saveNote = async (projectId, input, contextSessionId) => {
    rejectExpectedOnCreate(input);
    const body = requiredString(input, 'body', NOTE_MAX_LENGTH);
    if (input.id === undefined) {
      const sessionId = asNonEmptyString(contextSessionId);
      if (!sessionId) throw new OpenChamberControlError('Creating a note requires a calling session', 400);
      const { note } = await runtime.createNote(projectId, { body, source: 'agent', origin: { sessionId } });
      return { projectId, note };
    }
    const id = idOf(input);
    const expected = expectedOf(input);
    const saved = found(await runtime.updateNote(projectId, id, { body }, expected === undefined ? {} : { expectedBody: expected }), 'Note', id);
    return { projectId, note: saved.note };
  };

  const saveTodo = async (projectId, input) => {
    if (input.expected !== undefined) {
      throw new OpenChamberControlError('expected applies to notes and plans; a todo save changes only the fields it names', 400);
    }
    const completed = completedOf(input);
    if (input.id === undefined) {
      const text = requiredString(input, 'body', TODO_MAX_LENGTH);
      return { projectId, todo: (await runtime.createTodo(projectId, { text, completed: completed === true })).todo };
    }
    const id = idOf(input);
    const patch = {};
    if (input.body !== undefined) patch.text = requiredString(input, 'body', TODO_MAX_LENGTH);
    if (completed !== undefined) patch.completed = completed;
    if (patch.text === undefined && patch.completed === undefined) {
      throw new OpenChamberControlError('body or completed is required to change a todo', 400);
    }
    const { todos } = await runtime.updateTodo(projectId, id, patch);
    return { projectId, todo: todos.find((entry) => entry.id === id) };
  };

  const savePlan = async (projectId, input) => {
    rejectExpectedOnCreate(input);
    const body = requiredString(input, 'body', PLAN_MAX_LENGTH);
    if (input.id === undefined) {
      if (!/^\s*#\s+\S/.test(body)) {
        throw new OpenChamberControlError('A plan starts with a # title line', 400);
      }
      // The first heading is the title, as it is when the user edits a plan.
      const { plan } = await runtime.createPlan(projectId, parsePlanMarkdown(body));
      const stored = found(await runtime.readPlan(projectId, plan.id), 'Plan', plan.id);
      return withStepsCheck({ projectId, plan: planEntry(plan, stored.path) }, body);
    }
    const id = idOf(input);
    const expected = expectedOf(input);
    const saved = found(await runtime.updatePlan(projectId, id, { raw: body }, expected === undefined ? {} : { expectedRaw: expected }), 'Plan', id);
    const stored = found(await runtime.readPlan(projectId, id), 'Plan', id);
    return withStepsCheck({ projectId, plan: planEntry(saved.plan, stored.path) }, body);
  };

  const remove = async (projectId, input) => {
    const kind = kindOf(input, ['note', 'todo', 'plan']);
    const id = idOf(input);
    if (kind === 'todo') {
      await runtime.deleteTodo(projectId, id);
      return { projectId, deleted: true };
    }
    const result = kind === 'note' ? await runtime.deleteNote(projectId, id) : await runtime.deletePlan(projectId, id);
    found(result.deleted, kind === 'note' ? 'Note' : 'Plan', id);
    return { projectId, deleted: true };
  };

  const show = async (projectId, directory, input, contextSessionId) => {
    kindOf(input, ['plan']);
    const id = idOf(input);
    if (!showPlan) throw new OpenChamberControlError('Showing a plan is not available on this server', 503);
    const plan = found(await runtime.readPlan(projectId, id), 'Plan', id);
    const delivered = showPlan({
      projectId,
      planId: plan.id,
      title: plan.title,
      directory,
      sessionId: asNonEmptyString(contextSessionId) ?? null,
    });
    if (delivered === 0) throw new OpenChamberControlError('No OpenChamber window is connected to show the plan', 503);
    return { projectId, planId: plan.id, shown: true };
  };

  const execute = async (action, input, contextDirectory, contextSessionId) => {
    if (!runtime || !resolveProjectContextId) {
      throw new OpenChamberControlError('Project knowledge is not available on this server', 503);
    }
    if (!await isEnabled()) {
      throw new OpenChamberControlError('The project knowledge tool is turned off in OpenChamber settings', 403);
    }
    const { projectId, directory } = await ownerOf(input, contextDirectory);
    switch (action) {
      case 'knowledge.list': return list(projectId);
      case 'knowledge.save': {
        const kind = kindOf(input, ['note', 'todo', 'plan']);
        if (kind === 'note') return saveNote(projectId, input, contextSessionId);
        if (kind === 'todo') return saveTodo(projectId, input);
        return savePlan(projectId, input);
      }
      case 'knowledge.delete': return remove(projectId, input);
      case 'knowledge.show': return show(projectId, directory, input, contextSessionId);
      default: throw new OpenChamberControlError(`Unsupported project knowledge action: ${action}`, 400);
    }
  };
  return { execute };
};
