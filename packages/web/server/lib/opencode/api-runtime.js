import {
  OpenCode,
  isMessageNotFoundError,
  isPermissionNotFoundError,
  isSessionNotFoundError,
} from '@opencode-ai/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const DEFAULT_TIMEOUT_MS = 15_000;
const SESSION_PAGE_LIMIT = 100;
const MAX_SESSION_PAGES = 100;
const MAX_SESSION_DESCENDANTS = 10_000;

export class UnsupportedOpenCodeOperationError extends Error {
  constructor(operation, protocol) {
    super(`${operation} is not supported by ${protocol === 'opencode2' ? 'OpenCode V2' : 'the active OpenCode runtime'}`);
    this.name = 'UnsupportedOpenCodeOperationError';
    this.code = 'OPENCODE_OPERATION_UNSUPPORTED';
    this.statusCode = 501;
    this.operation = operation;
    this.protocol = protocol;
  }
}

const asSignal = (options = {}) => options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

const legacyData = async (request, operation) => {
  const result = await request;
  if (result?.error) throw result.error;
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) {
    throw new Error(`OpenCode ${operation} returned an invalid response`);
  }
  return result.data;
};

const assignWhen = (target, key, value, enabled) => {
  if (enabled) target[key] = value;
  return target;
};

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

const normalizeV2Session = (session) => {
  const normalized = {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    directory: session.location?.directory ?? '',
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: session.title ?? session.id,
    version: '2',
    time: session.time,
  };
  if (session.location?.workspaceID) normalized.workspaceID = session.location.workspaceID;
  if (session.subpath) normalized.path = session.subpath;
  if (session.parentID) normalized.parentID = session.parentID;
  if (session.agent) normalized.agent = session.agent;
  if (session.model) {
    normalized.model = { providerID: session.model.providerID, modelID: session.model.id, id: session.model.id };
    if (session.model.variant) normalized.model.variant = session.model.variant;
  }
  if (session.revert) normalized.revert = session.revert;
  return normalized;
};

const normalizeV2ToolPart = (sessionID, messageID, tool) => {
  const base = {
    id: tool.id,
    sessionID,
    messageID,
    type: 'tool',
    callID: tool.id,
    tool: tool.name,
  };
  if (tool.state.status === 'streaming') {
    return { ...base, state: { status: 'pending', input: {}, raw: tool.state.input } };
  }
  if (tool.state.status === 'running') {
    return {
      ...base,
      state: {
        status: 'running',
        input: tool.state.input,
        metadata: tool.state.metadata,
        time: { start: tool.time.created },
      },
    };
  }
  if (tool.state.status === 'error') {
    const state = {
      status: 'error',
      input: tool.state.input,
      error: tool.state.error.message,
      time: { start: tool.time.created, end: tool.time.completed ?? tool.time.created },
    };
    assignWhen(state, 'metadata', tool.state.metadata, Boolean(tool.state.metadata));
    return {
      ...base,
      state,
    };
  }
  const text = tool.state.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  const attachments = tool.state.content
    .filter((item) => item.type === 'file')
    .map((item, index) => {
      const attachment = {
        id: `${tool.id}:file:${index}`,
        sessionID,
        messageID,
        type: 'file',
        mime: item.mime,
        url: item.uri,
      };
      return assignWhen(attachment, 'filename', item.name, Boolean(item.name));
    });
  const state = {
    status: 'completed',
    input: tool.state.input,
    output: text,
    title: tool.name,
    metadata: tool.state.metadata ?? {},
    time: { start: tool.time.created, end: tool.time.completed ?? tool.time.created },
  };
  assignWhen(state, 'attachments', attachments, attachments.length > 0);
  return {
    ...base,
    state,
  };
};

const normalizeV2Message = (sessionID, message, session, parentID = '') => {
  if (message.type === 'user') {
    const model = {
      providerID: session?.model?.providerID ?? '',
      modelID: session?.model?.modelID ?? session?.model?.id ?? '',
    };
    assignWhen(model, 'variant', session?.model?.variant, Boolean(session?.model?.variant));
    const info = {
      id: message.id,
      sessionID,
      role: 'user',
      time: message.time,
      agent: session?.agent ?? '',
      model,
    };
    assignWhen(info, 'metadata', message.metadata, Boolean(message.metadata));
    const parts = [{ id: `${message.id}:text:0`, sessionID, messageID: message.id, type: 'text', text: message.text }];
    for (const [index, file] of (message.files ?? []).entries()) {
      const part = {
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: 'file',
        mime: file.mime,
        url: file.source?.type === 'uri' ? file.source.uri : `data:${file.mime};base64,${file.data}`,
      };
      parts.push(assignWhen(part, 'filename', file.name, Boolean(file.name)));
    }
    return { info, parts };
  }

  if (message.type === 'assistant') {
    const info = {
      id: message.id,
      sessionID,
      role: 'assistant',
      time: message.time,
      parentID,
      modelID: message.model.id,
      providerID: message.model.providerID,
      mode: message.agent,
      agent: message.agent,
      path: { cwd: session?.directory ?? '', root: session?.directory ?? '' },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    assignWhen(info, 'variant', message.model.variant, Boolean(message.model.variant));
    assignWhen(info, 'finish', message.finish, Boolean(message.finish));
    assignWhen(info, 'error', message.error ? { name: message.error.type, data: { message: message.error.message } } : undefined, Boolean(message.error));
    assignWhen(info, 'metadata', message.metadata, Boolean(message.metadata));
    const parts = message.content.map((content, index) => {
      if (content.type === 'text') {
        return { id: `${message.id}:text:${index}`, sessionID, messageID: message.id, type: 'text', text: content.text };
      }
      if (content.type === 'reasoning') {
        const time = { start: content.time?.created ?? message.time.created };
        assignWhen(time, 'end', content.time?.completed, Boolean(content.time?.completed));
        return {
          id: `${message.id}:reasoning:${index}`,
          sessionID,
          messageID: message.id,
          type: 'reasoning',
          text: content.text,
          time,
        };
      }
      return normalizeV2ToolPart(sessionID, message.id, content);
    });
    return { info, parts };
  }

  if (message.type === 'compaction') {
    const completed = message.status === 'completed' ? message.time.created : undefined;
    const time = { created: message.time.created };
    assignWhen(time, 'completed', completed, Boolean(completed));
    const info = {
      id: message.id,
      sessionID,
      role: 'assistant',
      parentID,
      summary: true,
      mode: 'compaction',
      agent: 'compaction',
      providerID: '',
      modelID: '',
      time,
    };
    assignWhen(info, 'error', message.status === 'failed'
      ? { name: message.error.type, data: { message: message.error.message } }
      : undefined, message.status === 'failed');
    return {
      info,
      parts: [{
        id: `${message.id}:text:0`,
        sessionID,
        messageID: message.id,
        type: 'text',
        text: message.summary ?? '',
      }],
    };
  }

  return null;
};

const normalizeV2Messages = (sessionID, messages, session) => {
  let latestUserID = '';
  const normalized = [];
  for (const message of messages) {
    const record = normalizeV2Message(sessionID, message, session, latestUserID);
    if (!record) continue;
    normalized.push(record);
    if (record.info.role === 'user') latestUserID = record.info.id;
  }
  return normalized;
};

const normalizeV2Agent = (agent) => ({
  name: agent.name,
  description: agent.description,
  mode: agent.mode,
  hidden: agent.hidden,
  color: agent.color,
  permission: (agent.permissions ?? []).map((rule) => ({
    permission: rule.action,
    pattern: rule.resource,
    action: rule.effect,
  })),
  model: agent.model ? { providerID: agent.model.providerID, modelID: agent.model.id } : undefined,
  variant: agent.model?.variant,
  prompt: agent.system,
  options: agent.request?.settings,
  steps: agent.steps,
});

const normalizeV2Model = (model) => ({
  id: model.id,
  providerID: model.providerID,
  name: model.name,
  family: model.family,
  capabilities: {
    attachment: model.capabilities.input.some((type) => type !== 'text'),
    toolcall: model.capabilities.tools,
    input: Object.fromEntries(['text', 'audio', 'image', 'video', 'pdf'].map((type) => [type, model.capabilities.input.includes(type)])),
    output: Object.fromEntries(['text', 'audio', 'image', 'video', 'pdf'].map((type) => [type, model.capabilities.output.includes(type)])),
  },
  limit: model.limit,
  status: model.status,
  options: model.settings,
  headers: model.headers,
  release_date: new Date(model.time.released).toISOString(),
  variants: Object.fromEntries((model.variants ?? []).map((variant) => [variant.id, variant.settings])),
});

export const createOpenCodeApiRuntime = (dependencies) => {
  const {
    getOpenCodeProtocol,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    createLegacyClient = createOpencodeClient,
    createV2Client = OpenCode.make,
  } = dependencies;

  const context = (directory, options = {}) => {
    const protocol = getOpenCodeProtocol?.();
    if (protocol !== 'legacy' && protocol !== 'opencode2') {
      throw new Error('OpenCode protocol is not available');
    }
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/+$/, '');
    const headers = getOpenCodeAuthHeaders();
    const signal = asSignal(options);
    const legacyOptions = { baseUrl, headers };
    assignWhen(legacyOptions, 'directory', directory, Boolean(directory));
    return {
      protocol,
      signal,
      legacy: protocol === 'legacy'
        ? createLegacyClient(legacyOptions)
        : null,
      v2: protocol === 'opencode2' ? createV2Client({ baseUrl, headers }) : null,
    };
  };

  const unsupported = (operation, protocol) => {
    throw new UnsupportedOpenCodeOperationError(operation, protocol);
  };

  const listV2SessionPages = async (client, input, budget, parentID, signal) => {
    const sessions = [];
    const seenCursors = new Set();
    let cursor = input.cursor;
    while (budget.remaining > 0) {
      budget.remaining -= 1;
      const request = {
        limit: Math.min(input.limit ?? SESSION_PAGE_LIMIT, SESSION_PAGE_LIMIT),
        order: 'desc',
      };
      assignWhen(request, 'directory', input.directory, Boolean(input.directory));
      assignWhen(request, 'parentID', parentID, parentID !== undefined);
      assignWhen(request, 'cursor', cursor, Boolean(cursor));
      const response = await client.session.list(request, { signal });
      sessions.push(...response.data.map(normalizeV2Session));
      const next = response.cursor.next ?? undefined;
      if (!input.allPages || !next || next === cursor || seenCursors.has(next)) {
        return { sessions, cursor: next };
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error('OpenCode V2 session pagination limit exceeded');
  };

  const listSessions = async (input = {}, options = {}) => {
    const runtime = context(input.directory, options);
    if (runtime.protocol === 'legacy') {
      const method = input.global === true && runtime.legacy.experimental?.session?.list
        ? runtime.legacy.experimental.session.list.bind(runtime.legacy.experimental.session)
        : runtime.legacy.session.list.bind(runtime.legacy.session);
      const request = {};
      assignWhen(request, 'directory', input.directory, Boolean(input.directory));
      assignWhen(request, 'roots', input.roots, input.roots !== undefined);
      assignWhen(request, 'archived', input.archived, input.archived !== undefined);
      assignWhen(request, 'limit', input.limit, Boolean(input.limit));
      assignWhen(request, 'cursor', input.cursor, input.cursor !== undefined);
      const data = await legacyData(method(request, { signal: runtime.signal }), 'session.list');
      return { sessions: Array.isArray(data) ? data : [], cursor: undefined };
    }

    const rootsOnly = input.roots === true;
    const includeDescendants = input.roots === false;
    const budget = { remaining: MAX_SESSION_PAGES };
    const rootPage = await listV2SessionPages(runtime.v2, input, budget, rootsOnly || includeDescendants ? null : undefined, runtime.signal);
    const sessions = [...rootPage.sessions];
    if (includeDescendants && input.cursor === undefined) {
      const queue = [...sessions];
      const visited = new Set(queue.map((session) => session.id));
      while (queue.length > 0 && sessions.length < MAX_SESSION_DESCENDANTS) {
        const parent = queue.shift();
        const page = await listV2SessionPages(runtime.v2, { ...input, cursor: undefined }, budget, parent.id, runtime.signal);
        for (const child of page.sessions) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          sessions.push(child);
          queue.push(child);
        }
      }
      if (queue.length > 0) throw new Error('OpenCode V2 descendant session limit exceeded');
    }
    const filtered = input.archived === true ? sessions : sessions.filter((session) => !session.time?.archived);
    return { sessions: filtered, cursor: rootPage.cursor };
  };

  const getSession = async (sessionID, directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      const request = { sessionID };
      assignWhen(request, 'directory', directory, Boolean(directory));
      return legacyData(runtime.legacy.session.get(request, { signal: runtime.signal }), 'session.get');
    }
    return normalizeV2Session(await runtime.v2.session.get({ sessionID }, { signal: runtime.signal }));
  };

  const createSession = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    if (runtime.protocol === 'legacy') {
      const request = { directory: input.directory };
      assignWhen(request, 'title', input.title, Boolean(input.title));
      assignWhen(request, 'agent', input.agent, Boolean(input.agent));
      assignWhen(request, 'model', input.model, Boolean(input.model));
      return legacyData(runtime.legacy.session.create(request, { signal: runtime.signal }), 'session.create');
    }
    const model = input.model
      ? assignWhen({
        providerID: input.model.providerID,
        id: input.model.id ?? input.model.modelID,
      }, 'variant', input.model.variant, Boolean(input.model.variant))
      : undefined;
    const request = { location: { directory: input.directory } };
    assignWhen(request, 'title', input.title, Boolean(input.title));
    assignWhen(request, 'agent', input.agent, Boolean(input.agent));
    assignWhen(request, 'model', model, Boolean(model));
    const session = await runtime.v2.session.create(request, { signal: runtime.signal });
    return normalizeV2Session(session);
  };

  const forkSession = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    if (runtime.protocol === 'legacy') {
      const request = { sessionID: input.sessionID };
      assignWhen(request, 'directory', input.directory, Boolean(input.directory));
      assignWhen(request, 'messageID', input.messageID, Boolean(input.messageID));
      return legacyData(runtime.legacy.session.fork(request, { signal: runtime.signal }), 'session.fork');
    }
    const boundary = input.messageID
      ? { type: 'before', messageID: input.messageID }
      : { type: 'through' };
    return normalizeV2Session(await runtime.v2.session.fork({ sessionID: input.sessionID, boundary }, { signal: runtime.signal }));
  };

  const listMessages = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    if (runtime.protocol === 'legacy') {
      const request = { sessionID: input.sessionID };
      assignWhen(request, 'directory', input.directory, Boolean(input.directory));
      assignWhen(request, 'limit', input.limit, Boolean(input.limit));
      assignWhen(request, 'before', input.cursor, Boolean(input.cursor));
      const data = await legacyData(runtime.legacy.session.messages(request, { signal: runtime.signal }), 'session.messages');
      return { messages: Array.isArray(data) ? data : [], cursor: undefined };
    }

    const session = await getSession(input.sessionID, input.directory, { signal: runtime.signal });
    const pages = [];
    let cursor = input.cursor;
    let next;
    do {
      const request = {
        sessionID: input.sessionID,
        limit: input.limit ?? SESSION_PAGE_LIMIT,
        order: 'desc',
      };
      assignWhen(request, 'cursor', cursor, Boolean(cursor));
      const response = await runtime.v2.message.list(request, { signal: runtime.signal });
      pages.unshift([...response.data].reverse());
      next = response.cursor.next ?? response.cursor.previous ?? undefined;
      cursor = next;
    } while (input.allPages === true && next && pages.length < MAX_SESSION_PAGES);
    if (input.allPages === true && next && pages.length >= MAX_SESSION_PAGES) {
      throw new Error('OpenCode V2 message pagination limit exceeded');
    }
    return {
      messages: normalizeV2Messages(input.sessionID, pages.flat(), session),
      cursor: next,
    };
  };

  const getMessage = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    try {
      if (runtime.protocol === 'legacy') {
        const request = { sessionID: input.sessionID, messageID: input.messageID };
        assignWhen(request, 'directory', input.directory, Boolean(input.directory));
        return await legacyData(runtime.legacy.session.message(request, { signal: runtime.signal }), 'session.message');
      }
      const [session, message] = await Promise.all([
        getSession(input.sessionID, input.directory, { signal: runtime.signal }),
        runtime.v2.session.message({ sessionID: input.sessionID, messageID: input.messageID }, { signal: runtime.signal }),
      ]);
      return normalizeV2Message(input.sessionID, message, session);
    } catch (error) {
      if (isMessageNotFoundError(error) || isSessionNotFoundError(error) || error?.statusCode === 404 || error?.status === 404) {
        return null;
      }
      throw error;
    }
  };

  const switchV2Selection = async (runtime, input) => {
    if (!input.agent && !input.model) return;
    const previous = input.agent && input.model
      ? await runtime.v2.session.get({ sessionID: input.sessionID }, { signal: runtime.signal })
      : null;
    if (input.agent) {
      await runtime.v2.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, { signal: runtime.signal });
    }
    try {
      if (input.model) {
        const model = {
          providerID: input.model.providerID,
          id: input.model.id ?? input.model.modelID,
        };
        assignWhen(model, 'variant', input.variant, Boolean(input.variant));
        await runtime.v2.session.switchModel({
          sessionID: input.sessionID,
          model,
        }, { signal: runtime.signal });
      }
    } catch (error) {
      if (previous?.agent) {
        try {
          await runtime.v2.session.switchAgent({ sessionID: input.sessionID, agent: previous.agent }, { signal: runtime.signal });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'OpenCode V2 model switch failed and agent rollback failed');
        }
      }
      throw error;
    }
  };

  const sendPrompt = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    if (runtime.protocol === 'legacy') {
      const request = { sessionID: input.sessionID, parts: input.parts ?? [] };
      assignWhen(request, 'directory', input.directory, Boolean(input.directory));
      assignWhen(request, 'messageID', input.messageID, Boolean(input.messageID));
      assignWhen(request, 'model', input.model, Boolean(input.model));
      assignWhen(request, 'agent', input.agent, Boolean(input.agent));
      assignWhen(request, 'variant', input.variant, Boolean(input.variant));
      assignWhen(request, 'delivery', input.delivery, Boolean(input.delivery));
      await legacyData(runtime.legacy.session.promptAsync(request, { signal: runtime.signal }), 'session.promptAsync');
      return true;
    }

    await switchV2Selection(runtime, input);
    const parts = input.parts ?? [];
    const synthetic = parts.filter((part) => part.type === 'text' && part.synthetic === true);
    const regular = parts.filter((part) => part.synthetic !== true);
    for (const [index, part] of synthetic.entries()) {
      await runtime.v2.session.synthetic({
        sessionID: input.sessionID,
        text: part.text,
        delivery: 'queue',
        resume: regular.length === 0 && index === synthetic.length - 1,
      }, { signal: runtime.signal });
    }
    if (regular.length === 0) return true;

    const text = regular.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const files = regular.filter((part) => part.type === 'file').map((part) => {
      const file = { uri: part.url };
      return assignWhen(file, 'name', part.filename, Boolean(part.filename));
    });
    const agents = regular.filter((part) => part.type === 'agent').map((part) => {
      const agent = { name: part.name };
      return assignWhen(agent, 'mention', part.source
        ? { start: part.source.start, end: part.source.end, text: part.source.value }
        : undefined, Boolean(part.source));
    });
    const request = { sessionID: input.sessionID, text };
    assignWhen(request, 'id', input.messageID, Boolean(input.messageID));
    assignWhen(request, 'files', files, files.length > 0);
    assignWhen(request, 'agents', agents, agents.length > 0);
    assignWhen(request, 'delivery', input.delivery, Boolean(input.delivery));
    await runtime.v2.session.prompt(request, { signal: runtime.signal });
    return true;
  };

  const runCommand = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    if (runtime.protocol === 'legacy') {
      return legacyData(runtime.legacy.session.command(input, { signal: runtime.signal }), 'session.command');
    }
    let model;
    if (input.model) {
      const separator = input.model.indexOf('/');
      if (separator <= 0 || separator === input.model.length - 1) {
        throw new Error('OpenCode V2 requires command models in provider/model form');
      }
      model = {
        providerID: input.model.slice(0, separator),
        id: input.model.slice(separator + 1),
      };
      assignWhen(model, 'variant', input.variant, Boolean(input.variant));
    }
    const request = {
      sessionID: input.sessionID,
      command: input.command,
      arguments: input.arguments,
      agent: input.agent,
      model,
      delivery: input.delivery,
    };
    assignWhen(request, 'id', input.messageID, Boolean(input.messageID));
    return runtime.v2.session.command(request, { signal: runtime.signal });
  };

  const listSessionChildren = async (sessionID, directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      const request = { sessionID };
      assignWhen(request, 'directory', directory, Boolean(directory));
      const data = await legacyData(runtime.legacy.session.children(request, { signal: runtime.signal }), 'session.children');
      return Array.isArray(data) ? data : [];
    }
    const page = await listV2SessionPages(runtime.v2, { directory, allPages: true }, { remaining: MAX_SESSION_PAGES }, sessionID, runtime.signal);
    return page.sessions;
  };

  const getSessionStatus = async (sessionID, directory, options = {}) => {
    let runtime;
    try {
      runtime = context(directory, options);
      if (runtime.protocol === 'legacy') {
        const request = {};
        assignWhen(request, 'directory', directory, Boolean(directory));
        const statuses = await legacyData(runtime.legacy.session.status(request, { signal: runtime.signal }), 'session.status');
        if (!isPlainObject(statuses)) {
          throw new Error('OpenCode session.status returned an invalid response');
        }
        return { kind: 'authoritative', status: statuses[sessionID] ?? { type: 'idle' } };
      }
      const active = await runtime.v2.session.active({ signal: runtime.signal });
      return active?.[sessionID]
        ? { kind: 'authoritative', status: { type: 'busy' } }
        : { kind: 'unknown' };
    } catch (error) {
      return { kind: 'unavailable', error };
    }
  };

  const listPendingPermissions = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      const data = await legacyData(runtime.legacy.permission.list(
        directory ? { directory } : undefined,
        { signal: runtime.signal },
      ), 'permission.list');
      return Array.isArray(data) ? data : [];
    }
    const request = {};
    assignWhen(request, 'location', { directory }, Boolean(directory));
    const response = await runtime.v2.permission.request.list(request, { signal: runtime.signal });
    return response.data;
  };

  const replyPermission = async (input, options = {}) => {
    const runtime = context(input.directory, options);
    try {
      if (runtime.protocol === 'legacy') {
        const request = {
          requestID: input.requestID,
          reply: input.reply,
        };
        assignWhen(request, 'directory', input.directory, Boolean(input.directory));
        assignWhen(request, 'message', input.message, Boolean(input.message));
        await legacyData(runtime.legacy.permission.reply(request, { signal: runtime.signal }), 'permission.reply');
      } else {
        const request = {
          sessionID: input.sessionID,
          requestID: input.requestID,
          reply: input.reply,
        };
        assignWhen(request, 'message', input.message, Boolean(input.message));
        await runtime.v2.permission.reply(request, { signal: runtime.signal });
      }
      return true;
    } catch (error) {
      if (isPermissionNotFoundError(error) || error?.statusCode === 404 || error?.status === 404) {
        return false;
      }
      throw error;
    }
  };

  const waitForSessionIdle = async (sessionID, directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'opencode2') {
      await runtime.v2.session.wait({ sessionID }, { signal: runtime.signal });
      return { type: 'idle' };
    }
    const pollMs = options.pollMs ?? 500;
    let observedActivity = false;
    while (true) {
      const state = await getSessionStatus(sessionID, directory, { signal: runtime.signal });
      if (state.kind === 'unavailable') throw state.error;
      if (state.kind === 'authoritative') {
        if (state.status.type === 'busy' || state.status.type === 'retry') {
          observedActivity = true;
        } else if (options.requireActivity !== true || observedActivity) {
          return state.status;
        } else {
          const { messages } = await listMessages({ sessionID, directory, limit: 100 }, { signal: runtime.signal });
          const assistant = [...messages].reverse().find((message) => message?.info?.role === 'assistant');
          const completedAt = assistant?.info?.time?.completed;
          if (completedAt && (options.baselineMessageID
            ? assistant.info.id !== options.baselineMessageID
            : completedAt >= (options.startedAt ?? 0))) {
            return state.status;
          }
        }
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, pollMs);
        runtime.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(runtime.signal.reason ?? new Error('OpenCode wait was cancelled'));
        }, { once: true });
      });
    }
  };

  const mergeSessionMetadata = async (sessionID, directory, mutate, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'opencode2') unsupported('session metadata', runtime.protocol);
    const getRequest = { sessionID };
    assignWhen(getRequest, 'directory', directory, Boolean(directory));
    const fresh = await legacyData(runtime.legacy.session.get(getRequest, { signal: runtime.signal }), 'session.get');
    const metadata = isPlainObject(fresh?.metadata)
      ? fresh.metadata
      : {};
    const next = await mutate(metadata, fresh);
    if (!isPlainObject(next)) {
      throw new Error('Session metadata mutation returned an invalid value');
    }
    const updateRequest = { sessionID, metadata: next };
    assignWhen(updateRequest, 'directory', directory, Boolean(directory));
    await legacyData(runtime.legacy.session.update(updateRequest, { signal: runtime.signal }), 'session.update');
    return next;
  };

  const listAgents = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      const data = await legacyData(runtime.legacy.app.agents(directory ? { directory } : undefined, { signal: runtime.signal }), 'app.agents');
      return Array.isArray(data) ? data : [];
    }
    const response = await runtime.v2.agent.list({ location: directory ? { directory } : undefined }, { signal: runtime.signal });
    return response.data.map(normalizeV2Agent);
  };

  const listProviders = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      return legacyData(runtime.legacy.config.providers(directory ? { directory } : undefined, { signal: runtime.signal }), 'config.providers');
    }
    const location = directory ? { directory } : undefined;
    const [providerResponse, modelResponse, defaultResponse] = await Promise.all([
      runtime.v2.provider.list({ location }, { signal: runtime.signal }),
      runtime.v2.model.list({ location }, { signal: runtime.signal }),
      runtime.v2.model.default({ location }, { signal: runtime.signal }),
    ]);
    const providers = providerResponse.data.map((provider) => ({
      id: provider.id,
      name: provider.name,
      options: provider.settings,
      models: {},
    }));
    const byID = new Map(providers.map((provider) => [provider.id, provider]));
    for (const model of modelResponse.data) {
      const provider = byID.get(model.providerID);
      if (provider) provider.models[model.id] = normalizeV2Model(model);
    }
    return {
      providers,
      default: defaultResponse.data ? { [defaultResponse.data.providerID]: defaultResponse.data.id } : {},
    };
  };

  const getRuntimeProviderListing = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'opencode2') unsupported('runtime provider credentials', runtime.protocol);
    return legacyData(runtime.legacy.provider.list(
      directory ? { directory } : undefined,
      { signal: runtime.signal },
    ), 'provider.list');
  };

  const getConfig = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      return legacyData(runtime.legacy.config.get(directory ? { directory } : undefined, { signal: runtime.signal }), 'config.get');
    }
    const response = await runtime.v2.config.get({ location: directory ? { directory } : undefined }, { signal: runtime.signal });
    return response.data;
  };

  const listCommands = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      const data = await legacyData(runtime.legacy.command.list(directory ? { directory } : undefined, { signal: runtime.signal }), 'command.list');
      return Array.isArray(data) ? data : [];
    }
    const response = await runtime.v2.command.list({ location: directory ? { directory } : undefined }, { signal: runtime.signal });
    return response.data;
  };

  const listSkills = async (directory, options = {}) => {
    const runtime = context(directory, options);
    if (runtime.protocol === 'legacy') {
      const data = await legacyData(runtime.legacy.app.skills(directory ? { directory } : undefined, { signal: runtime.signal }), 'app.skills');
      return Array.isArray(data) ? data : [];
    }
    const response = await runtime.v2.skill.list({ location: directory ? { directory } : undefined }, { signal: runtime.signal });
    return response.data;
  };

  const supportsSessionMetadata = () => getOpenCodeProtocol?.() === 'legacy';

  return {
    listSessions,
    getSession,
    createSession,
    forkSession,
    listMessages,
    getMessage,
    sendPrompt,
    runCommand,
    listSessionChildren,
    getSessionStatus,
    listPendingPermissions,
    replyPermission,
    waitForSessionIdle,
    mergeSessionMetadata,
    listAgents,
    listProviders,
    getRuntimeProviderListing,
    getConfig,
    listCommands,
    listSkills,
    supportsSessionMetadata,
  };
};
