import { asNonEmptyString } from '../shared/guards.js';
import { MEMORY_BODY_MAX_LENGTH, MEMORY_TITLE_MAX_LENGTH } from './runtime.js';

const MEMORY_TYPES = new Set(['fact', 'preference', 'reference']);

const toSummary = (entry, scope) => ({
  memoryId: entry.id,
  title: entry.title,
  type: entry.type,
  scope,
});

const RELATED_NOTE = 'Stored as a new entry. These stored entries share much of its wording. If it replaces or reverses one of them, rewrite that one by memoryId to what holds now, with a line on what changed and why, then delete the entry just saved. If they are about different things, leave both.';

const toFullEntry = (entry, scope) => ({ ...toSummary(entry, scope), body: entry.body });

export const createAgentMemoryActions = (dependencies) => {
  const {
    agentMemoryRuntime,
    createError,
    onMemoryChanged,
    resolveProjectId: resolveProjectIdForDirectory,
    isAgentMemoryEnabled,
  } = dependencies;

  const announce = (scope, projectId) => {
    if (typeof onMemoryChanged !== 'function') return;
    try {
      onMemoryChanged({ scope, ...(projectId ? { projectId } : {}) });
    } catch {
      // A listener that throws must not take the write down with it.
    }
  };

  const fail = (message, status = 400) => {
    throw createError(message, status);
  };

  const resolveProjectId = async (contextDirectory) => {
    const directory = asNonEmptyString(contextDirectory);
    const projectId = directory ? await resolveProjectIdForDirectory(directory) : '';
    if (!projectId) {
      fail('Project memory needs a session directory, and this session has none', 400);
    }
    return projectId;
  };

  const resolveTarget = async (input, contextDirectory) => {
    const scope = asNonEmptyString(input.scope);
    if (scope === 'global') return { scope: 'global' };
    if (scope === 'project') {
      return { scope: 'project', projectId: await resolveProjectId(contextDirectory) };
    }
    return fail('scope must be global or project', 400);
  };

  const listBothScopes = async (contextDirectory) => {
    const directory = asNonEmptyString(contextDirectory);
    const projectId = directory ? await resolveProjectIdForDirectory(directory) : null;
    const result = await agentMemoryRuntime.readAll(projectId);

    return {
      memories: [
        ...result.global.map((entry) => toSummary(entry, 'global')),
        ...result.project.map((entry) => toSummary(entry, 'project')),
      ],
      ...(result.globalFailed ? { globalUnavailable: true } : {}),
      ...(result.projectFailed ? { projectUnavailable: true } : {}),
    };
  };

  const list = async (input, contextDirectory) => {
    const scope = asNonEmptyString(input.scope);
    if (!scope || scope === 'both') {
      return listBothScopes(contextDirectory);
    }
    const target = await resolveTarget(input, contextDirectory);
    const { entries } = await agentMemoryRuntime.read(target);
    return { memories: entries.map((entry) => toSummary(entry, target.scope)) };
  };

  const read = async (input, contextDirectory) => {
    const memoryId = asNonEmptyString(input.memoryId);
    const title = asNonEmptyString(input.title);
    if (!memoryId && !title) {
      fail('memory.read requires memoryId or title', 400);
    }

    const matches = (entry) => (memoryId
      ? entry.id === memoryId
      : entry.title.toLowerCase() === title.toLowerCase());

    const requestedScope = asNonEmptyString(input.scope);
    if (requestedScope === 'global' || requestedScope === 'project') {
      const target = await resolveTarget(input, contextDirectory);
      const { entries } = await agentMemoryRuntime.read(target);
      const found = entries.find(matches);
      if (!found) {
        fail('No memory matches that id or title in this scope', 404);
      }
      return { memory: toFullEntry(found, target.scope) };
    }

    const directory = asNonEmptyString(contextDirectory);
    const projectId = directory ? await resolveProjectIdForDirectory(directory) : null;
    const result = await agentMemoryRuntime.readAll(projectId);

    const projectMatch = result.project.find(matches);
    if (projectMatch) {
      return { memory: toFullEntry(projectMatch, 'project') };
    }
    const globalMatch = result.global.find(matches);
    if (globalMatch) {
      return { memory: toFullEntry(globalMatch, 'global') };
    }
    if (result.globalFailed || result.projectFailed) {
      fail('Stored memory could not be read; try again before assuming it is absent', 503);
    }
    fail('No memory matches that id or title', 404);
  };

  const save = async (input, contextDirectory) => {
    const target = await resolveTarget(input, contextDirectory);
    const title = asNonEmptyString(input.title);
    const body = asNonEmptyString(input.body);
    if (!title) fail('title is required for memory.save', 400);
    if (!body) fail('body is required for memory.save', 400);
    if (title.length > MEMORY_TITLE_MAX_LENGTH) {
      fail(`title holds at most ${MEMORY_TITLE_MAX_LENGTH} characters, and this one is ${title.length}`, 400);
    }
    if (body.trim().length > MEMORY_BODY_MAX_LENGTH) {
      fail(`body holds at most ${MEMORY_BODY_MAX_LENGTH} characters, and this one is ${body.trim().length}`, 400);
    }
    if (input.type !== undefined && !MEMORY_TYPES.has(input.type)) {
      fail('type must be fact, preference, or reference', 400);
    }

    const memoryId = asNonEmptyString(input.memoryId);
    let saved;
    if (memoryId) {
      const rewritten = await agentMemoryRuntime.update(target, memoryId, { title, body, type: input.type });
      if (!rewritten) {
        fail('No memory has that id in this scope', 404);
      }
      saved = { entry: rewritten.entry, replaced: true };
    } else {
      saved = await agentMemoryRuntime.create(target, {
        title,
        body,
        type: input.type,
        sessionId: asNonEmptyString(input.sessionId),
      });
    }
    announce(target.scope, target.projectId);
    const hasRelated = saved.related?.length > 0;
    return {
      saved: true,
      memory: toSummary(saved.entry, target.scope),
      replaced: saved.replaced,
      related: hasRelated ? saved.related.map((entry) => toSummary(entry, target.scope)) : undefined,
      relatedNote: hasRelated ? RELATED_NOTE : undefined,
      ...(saved.entry.flagged
        ? { warning: 'Stored, but held back from future sessions: this text reads as an instruction to the model rather than a fact. The user can see it in the Memory panel.' }
        : {}),
    };
  };

  const remove = async (input, contextDirectory) => {
    const target = await resolveTarget(input, contextDirectory);
    const memoryId = asNonEmptyString(input.memoryId);
    if (!memoryId) fail('memoryId is required for memory.delete', 400);

    const result = await agentMemoryRuntime.remove(target, memoryId);
    if (!result.deleted) {
      fail('No memory has that id in this scope', 404);
    }
    announce(target.scope, target.projectId);
    return { deleted: true, memoryId };
  };

  const execute = async (action, input = {}, contextDirectory) => {
    if (typeof isAgentMemoryEnabled === 'function') {
      let enabled = false;
      try {
        enabled = await isAgentMemoryEnabled();
      } catch {
        // An unreadable setting closes the surface rather than opening it.
        enabled = false;
      }
      if (!enabled) {
        return fail('Agent memory is switched off in OpenChamber settings', 403);
      }
    }

    switch (action) {
      case 'memory.list': return list(input, contextDirectory);
      case 'memory.read': return read(input, contextDirectory);
      case 'memory.save': return save(input, contextDirectory);
      case 'memory.delete': return remove(input, contextDirectory);
      default: return fail(`Unsupported memory action: ${action || 'missing'}`, 400);
    }
  };

  return { execute };
};
