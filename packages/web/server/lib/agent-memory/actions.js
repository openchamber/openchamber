/**
 * Dispatch for the `memory.*` actions the `openchamber_memory` tool calls.
 *
 * Kept beside the store rather than inside the control service, because the
 * control service already owns sessions, schedules and the browser; memory
 * shares none of that machinery and only needs the same envelope.
 *
 * Project scope is derived from the session's directory, never from the model.
 * Letting the agent name a project id would let a memory learned in one
 * checkout be filed against another, which the user would have no way to
 * notice.
 *
 * The directory is resolved to the project first. A session running in a
 * worktree has the worktree's own path, and keying memory by that path filed it
 * under a project the panel never looks at — the memory was written, stored,
 * and invisible. Every worktree of a repository shares one project memory,
 * which is also what the user means by "this project".
 */

const MEMORY_TYPES = new Set(['fact', 'preference', 'reference']);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Everything the agent is told about an entry it has not opened yet. */
const toSummary = (entry, scope) => ({
  memoryId: entry.id,
  title: entry.title,
  type: entry.type,
  scope,
});

const toFullEntry = (entry, scope) => ({ ...toSummary(entry, scope), body: entry.body });

export const createAgentMemoryActions = (dependencies) => {
  const {
    agentMemoryRuntime,
    createError,
    onMemoryChanged,
    resolveProjectId: resolveProjectIdForDirectory,
    isAgentMemoryEnabled,
  } = dependencies;

  /**
   * Announce a write so an open panel shows it without being reopened. The
   * agent writes here on its own initiative, so without this the user only
   * learns what was stored the next time something else happens to reload.
   *
   * Never allowed to fail the action: the memory is already on disk, and a
   * broken notification must not report the write as failed.
   */
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

    // A scope that failed to load is reported, never rendered as empty: an
    // agent told it has no memories will happily store them all again.
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

  /**
   * Reading by title as well as by id is deliberate: the session index lists
   * titles only, so requiring an id would force a list call before every read
   * just to translate what the agent can already see.
   *
   * Scope is optional here. It decides everything for a write — a fact filed
   * globally reaches every project — but for a read it is only which drawer to
   * open, and demanding it turned a legible request into an error the model had
   * to recover from. Omitted, both stores are searched.
   */
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
      // Project first: when both stores hold the same title, the one about this
      // codebase is the one being asked about.
      return { memory: toFullEntry(projectMatch, 'project') };
    }
    const globalMatch = result.global.find(matches);
    if (globalMatch) {
      return { memory: toFullEntry(globalMatch, 'global') };
    }
    if (result.globalFailed || result.projectFailed) {
      // Never reported as "no such memory": a store that failed to load may well
      // hold it, and the agent would go on to store it a second time.
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
    if (input.type !== undefined && !MEMORY_TYPES.has(input.type)) {
      fail('type must be fact, preference, or reference', 400);
    }

    const result = await agentMemoryRuntime.create(target, {
      title,
      body,
      type: input.type,
      sessionId: asNonEmptyString(input.sessionId),
    });
    announce(target.scope, target.projectId);
    // Deliberately does not echo the text back. Handing the model what it just
    // wrote invites it to find something to improve and re-save, and the store
    // is not the place to discover that a save worked — the confirmation is.
    return {
      saved: true,
      memory: toSummary(result.entry, target.scope),
      // Told plainly so the agent does not report storing a second memory when
      // it actually corrected one it had already written.
      replaced: result.replaced,
      ...(result.entry.flagged
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
    /**
     * The tool lives in the managed OpenCode child and only disappears when
     * that child restarts, so between switching memory off and restarting it
     * the agent can still call this. Ungated, those writes would land on disk
     * while the panel that shows them is hidden and the index that carries
     * them is suppressed — memory accumulating where nobody can see it.
     */
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
