import path from 'node:path';
import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

const stringInput = z.string();
const completedInput = z.boolean();

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

const found = (value, kind, id) => {
  if (!value) throw new OpenChamberControlError(`${kind} not found: ${id}`, 404);
  return value;
};

/** Scope and input parsing for direct calls to the server-owned knowledge store. */
export const createProjectKnowledgeActions = ({ projectContextRuntime: runtime, resolveProjectContextId, resolveDirectory }) => {
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
    return projectId;
  };

  const execute = async (action, input, contextDirectory, contextSessionId) => {
    if (!runtime || !resolveProjectContextId) {
      throw new OpenChamberControlError('Project knowledge is not available on this server', 503);
    }
    const projectId = await ownerOf(input, contextDirectory);
    switch (action) {
      case 'notes.list': return { projectId, notes: (await runtime.readContext(projectId)).notes };
      case 'notes.read': {
        const id = requiredString(input, 'noteId').trim();
        const note = (await runtime.readContext(projectId)).notes.find((entry) => entry.id === id);
        return { projectId, note: found(note, 'Note', id) };
      }
      case 'notes.create': {
        const body = requiredString(input, 'body', 3000);
        const sessionId = asNonEmptyString(contextSessionId);
        if (!sessionId) throw new OpenChamberControlError('notes.create requires a calling session', 400);
        return { projectId, ...await runtime.createNote(projectId, { body, source: 'agent', origin: { sessionId } }) };
      }
      case 'notes.update': {
        const id = requiredString(input, 'noteId').trim();
        const body = requiredString(input, 'body', 3000);
        const options = input.expectedBody === undefined ? {} : { expectedBody: requiredString(input, 'expectedBody', undefined, true) };
        return { projectId, ...found(await runtime.updateNote(projectId, id, { body }, options), 'Note', id) };
      }
      case 'notes.delete': {
        const id = requiredString(input, 'noteId').trim();
        const result = await runtime.deleteNote(projectId, id);
        found(result.deleted, 'Note', id);
        return { projectId, ...result };
      }
      case 'todos.list': return { projectId, todos: (await runtime.readContext(projectId)).todos };
      case 'todos.create': {
        const text = requiredString(input, 'text', 1000);
        return { projectId, context: await runtime.createTodo(projectId, { text }) };
      }
      case 'todos.update': {
        const id = requiredString(input, 'todoId').trim();
        const patch = {};
        if (input.text !== undefined) patch.text = requiredString(input, 'text', 1000);
        if (input.completed !== undefined) {
          const completed = completedInput.safeParse(input.completed);
          if (!completed.success) throw new OpenChamberControlError('completed must be a boolean', 400);
          patch.completed = completed.data;
        }
        if (input.text === undefined && input.completed === undefined) {
          throw new OpenChamberControlError('text or completed is required', 400);
        }
        return { projectId, context: await runtime.updateTodo(projectId, id, patch) };
      }
      case 'todos.delete': {
        const id = requiredString(input, 'todoId').trim();
        return { projectId, deleted: true, context: await runtime.deleteTodo(projectId, id) };
      }
      case 'plans.list': return { projectId, plans: (await runtime.readContext(projectId)).plans };
      case 'plans.read': {
        const id = requiredString(input, 'planId').trim();
        return { projectId, plan: found(await runtime.readPlan(projectId, id), 'Plan', id) };
      }
      case 'plans.create': {
        const title = requiredString(input, 'title', 160);
        const body = requiredString(input, 'body', 200_000, true);
        return { projectId, ...await runtime.createPlan(projectId, { title, body }) };
      }
      case 'plans.update': {
        const id = requiredString(input, 'planId').trim();
        const raw = requiredString(input, 'raw', 200_000, true);
        const options = input.expectedRaw === undefined ? {} : { expectedRaw: requiredString(input, 'expectedRaw', undefined, true) };
        return { projectId, ...found(await runtime.updatePlan(projectId, id, { raw }, options), 'Plan', id) };
      }
      case 'plans.delete': {
        const id = requiredString(input, 'planId').trim();
        const result = await runtime.deletePlan(projectId, id);
        found(result.deleted, 'Plan', id);
        return { projectId, ...result };
      }
      default: throw new OpenChamberControlError(`Unsupported project knowledge action: ${action}`, 400);
    }
  };
  return { execute };
};
