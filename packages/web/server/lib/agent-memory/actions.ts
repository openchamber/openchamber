import { asNonEmptyString } from '../shared/guards.js';
import { MEMORY_BODY_MAX_LENGTH, MEMORY_TITLE_MAX_LENGTH } from './runtime.js';
import { isMemoryType } from './contracts.js';
import type { AgentMemoryRuntime } from './runtime.js';
import type { MemoryChangedEvent, MemoryEntry, MemoryScope, MemoryTarget, MemoryWriteInput } from './contracts.js';
import type { ControlInput } from '../openchamber-control/contracts.js';

interface MemoryActionInput extends MemoryWriteInput {
  scope?: unknown;
  memoryId?: unknown;
}

interface MemoryActionDependencies {
  agentMemoryRuntime: AgentMemoryRuntime;
  createError: (message: string, status: number) => Error;
  onMemoryChanged?: (event: MemoryChangedEvent) => void;
  resolveProjectId: (directory: string) => Promise<string>;
  isAgentMemoryEnabled?: () => boolean | Promise<boolean>;
}

const toSummary = (entry: MemoryEntry, scope: MemoryScope) => ({
  memoryId: entry.id,
  title: entry.title,
  type: entry.type,
  scope,
});

export type MemorySummary = ReturnType<typeof toSummary>;

export interface MemoryListResult {
  memories: MemorySummary[];
  globalUnavailable?: true;
  projectUnavailable?: true;
}

export interface MemorySaveResult {
  saved: true;
  memory: MemorySummary;
  replaced: boolean;
  related: MemorySummary[] | undefined;
  relatedNote: string | undefined;
  warning?: string;
}

const RELATED_NOTE = 'Stored as a new entry. These stored entries share much of its wording. If it replaces or reverses one of them, rewrite that one by memoryId to what holds now, with a line on what changed and why, then delete the entry just saved. If they are about different things, leave both.';

const toFullEntry = (entry: MemoryEntry, scope: MemoryScope) => ({ ...toSummary(entry, scope), body: entry.body });

export const createAgentMemoryActions = (dependencies: MemoryActionDependencies) => {
  const {
    agentMemoryRuntime,
    createError,
    onMemoryChanged,
    resolveProjectId: resolveProjectIdForDirectory,
    isAgentMemoryEnabled,
  } = dependencies;

  const announce = (scope: MemoryScope, projectId: string | undefined) => {
    if (!onMemoryChanged) return;
    try {
      const event: MemoryChangedEvent = { scope };
      if (projectId) event.projectId = projectId;
      onMemoryChanged(event);
    } catch {
      return;
    }
  };

  const fail: (message: string, status?: number) => never = (message, status = 400) => {
    throw createError(message, status);
  };

  const resolveProjectId = async (contextDirectory: ControlInput['directory']) => {
    const directory = asNonEmptyString(contextDirectory);
    const projectId = directory ? await resolveProjectIdForDirectory(directory) : '';
    if (!projectId) {
      fail('Project memory needs a session directory, and this session has none', 400);
    }
    return projectId;
  };

  const resolveTarget = async (input: MemoryActionInput, contextDirectory: ControlInput['directory']): Promise<MemoryTarget> => {
    const scope = asNonEmptyString(input.scope);
    if (scope === 'global') return { scope: 'global' };
    if (scope === 'project') {
      return { scope: 'project', projectId: await resolveProjectId(contextDirectory) };
    }
    return fail('scope must be global or project', 400);
  };

  const listBothScopes = async (contextDirectory: ControlInput['directory']) => {
    const directory = asNonEmptyString(contextDirectory);
    const projectId = directory ? await resolveProjectIdForDirectory(directory) : null;
    const result = await agentMemoryRuntime.readAll(projectId);

    const listed: MemoryListResult = {
      memories: [
        ...result.global.map((entry) => toSummary(entry, 'global')),
        ...result.project.map((entry) => toSummary(entry, 'project')),
      ],
    };
    if (result.globalFailed) listed.globalUnavailable = true;
    if (result.projectFailed) listed.projectUnavailable = true;
    return listed;
  };

  const list = async (input: MemoryActionInput, contextDirectory: ControlInput['directory']) => {
    const scope = asNonEmptyString(input.scope);
    if (!scope || scope === 'both') {
      return listBothScopes(contextDirectory);
    }
    const target = await resolveTarget(input, contextDirectory);
    const { entries } = await agentMemoryRuntime.read(target);
    return { memories: entries.map((entry) => toSummary(entry, target.scope)) };
  };

  const read = async (input: MemoryActionInput, contextDirectory: ControlInput['directory']) => {
    const memoryId = asNonEmptyString(input.memoryId);
    const title = asNonEmptyString(input.title);
    if (!memoryId && !title) {
      fail('memory.read requires memoryId or title', 400);
    }

    const matches = (entry: MemoryEntry) => (memoryId
      ? entry.id === memoryId
      : entry.title.toLowerCase() === title?.toLowerCase());

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

  const save = async (input: MemoryActionInput, contextDirectory: ControlInput['directory']) => {
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
    if (input.type !== undefined && !isMemoryType(input.type)) {
      fail('type must be fact, preference, or reference', 400);
    }

    const memoryId = asNonEmptyString(input.memoryId);
    let saved: Pick<Awaited<ReturnType<AgentMemoryRuntime['create']>>, 'entry' | 'replaced' | 'related'>;
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
    const hasRelated = (saved.related?.length ?? 0) > 0;
    const response: MemorySaveResult = {
      saved: true,
      memory: toSummary(saved.entry, target.scope),
      replaced: saved.replaced,
      related: hasRelated ? saved.related?.map((entry) => toSummary(entry, target.scope)) : undefined,
      relatedNote: hasRelated ? RELATED_NOTE : undefined,
    };
    if (saved.entry.flagged) {
      response.warning = 'Stored, but held back from future sessions: this text reads as an instruction to the model rather than a fact. The user can see it in the Memory panel.';
    }
    return response;
  };

  const remove = async (input: MemoryActionInput, contextDirectory: ControlInput['directory']) => {
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

  const execute = async (action: string, input: MemoryActionInput = {}, contextDirectory?: ControlInput['directory']) => {
    if (isAgentMemoryEnabled) {
      let enabled = false;
      try {
        enabled = await isAgentMemoryEnabled();
      } catch {
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
