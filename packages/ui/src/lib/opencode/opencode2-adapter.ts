import {
  OpenCode,
  isFormNotFoundError,
  isPermissionNotFoundError,
  type AgentInfo,
  type EventSubscribeOutput,
  type FileSystemEntry,
  type FormAnswer,
  type FormField,
  type FormInfo,
  type JsonValue,
  type LocationRef,
  type ModelInfo,
  type ModelRef,
  type PermissionRequest as V2PermissionRequest,
  type Project as V2Project,
  type SessionInfo,
  type SessionMessageAssistant,
  type SessionMessageAssistantTool,
  type SessionListInput as V2SessionListInput,
  type SessionMessageInfo,
  type SessionMessageUser,
  type SessionCreateInput as V2SessionCreateInput,
  type SessionPromptInput as V2SessionPromptInput,
  type ProviderInfo,
  type TokenUsageInfo,
} from '@opencode-ai/client';
import type {
  AgentPartInput,
  AssistantMessage,
  Event,
  FilePart,
  FilePartInput,
  GlobalEvent,
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  Project,
  QuestionInfo,
  QuestionRequest,
  Session,
  TextPartInput,
  ToolPart,
  UserMessage,
} from '@opencode-ai/sdk/v2';

export type OpenCodeProtocol = 'legacy' | 'opencode2';
export type OpenCodeProtocolDetector = () => Promise<OpenCodeProtocol>;
export type OpenCodeRuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const protocolDetectors = new WeakMap<OpencodeClient, OpenCodeProtocolDetector>();

export const resolveOpenCodeProtocol = (client: OpencodeClient): OpenCodeProtocol | Promise<OpenCodeProtocol> =>
  protocolDetectors.get(client)?.() ?? 'legacy';

type LegacyResult<T> = { data?: T; error?: Error; response?: Response };
type LegacyOptions = { signal?: AbortSignal; headers?: HeadersInit };
type LocationInput = { directory?: string; workspace?: string };
type SessionListInput = LocationInput & {
  roots?: boolean | 'true' | 'false';
  cursor?: number;
  limit?: number;
  archived?: boolean | 'true' | 'false';
};
type SessionInput = LocationInput & { sessionID: string };
type SessionCreateInput = LocationInput & {
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; modelID?: string; id?: string; variant?: string };
};
type SessionMessagesInput = SessionInput & { limit?: number; before?: string };
type SessionUpdateInput = SessionInput & {
  title?: string;
  metadata?: { [key: string]: JsonValue };
  permission?: unknown;
  time?: { archived?: number };
};
type SessionCommandInput = SessionInput & {
  messageID?: string;
  command: string;
  arguments?: string;
  model?: string;
  agent?: string;
  variant?: string;
  parts?: FilePartInput[];
};
type SessionForkInput = SessionInput & { messageID?: string };
type SessionSummarizeInput = SessionInput & { providerID: string; modelID: string };
type SessionRevertInput = SessionInput & { messageID: string; partID?: string };
type SessionMoveActionInput = { sessionID: string; destination: { directory: string }; moveChanges?: boolean };
type PromptPart = TextPartInput | FilePartInput | AgentPartInput;
type SessionPromptInput = SessionInput & {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  delivery?: 'steer' | 'queue';
  format?: { type: string };
  parts?: PromptPart[];
};
type PermissionReplyInput = LocationInput & {
  requestID: string;
  reply?: 'once' | 'always' | 'reject';
  message?: string;
};
type QuestionReplyInput = LocationInput & { requestID: string; answers?: string[][] };
type RequestForm = { sessionID: string; fields: FormField[] };
type ToolSnapshot = {
  sessionID: string;
  messageID: string;
  name: string;
  input: { [key: string]: JsonValue };
  started: number;
  metadata?: { [key: string]: JsonValue };
  raw: string;
};
type NormalizedMessage = { info: Message; parts: Part[] };
type SessionListQuery = { -readonly [Key in keyof V2SessionListInput]: V2SessionListInput[Key] };
type ReasoningTime = { start: number; end?: number };
type MutableSessionCreateInput = { -readonly [Key in keyof V2SessionCreateInput]: V2SessionCreateInput[Key] };
type MutableSessionPromptInput = { -readonly [Key in keyof V2SessionPromptInput]: V2SessionPromptInput[Key] };
type PromptFile = NonNullable<V2SessionPromptInput['files']>[number];
type PromptAgent = NonNullable<V2SessionPromptInput['agents']>[number];
type NormalizedCommand = { name: string; template: string; hints: string[]; description?: string; agent?: string; model?: string; subtask?: boolean };
type CompatibleModel = {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  capabilities: {
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
  };
  cost?: { input: number; output: number; cache: { read: number; write: number } };
  limit: ModelInfo['limit'];
  status: ModelInfo['status'];
  options: ModelInfo['settings'];
  headers: ModelInfo['headers'];
  release_date: string;
  variants: { [key: string]: NonNullable<ModelInfo['variants']>[number]['settings'] };
};
type CompatibleProvider = {
  id: string;
  name: string;
  options: ProviderInfo['settings'];
  models: { [key: string]: CompatibleModel };
};
type VcsResult = { branch?: string; default_branch?: string };
type AdapterCallResult = LegacyResult<unknown> | { stream: AsyncIterable<GlobalEvent> };

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const MAX_DESCENDANTS = 10_000;
const EMPTY_TOKENS: TokenUsageInfo = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const errorResult = (operation: string, error?: Error): LegacyResult<never> => ({
  error: error ?? new Error(`${operation} is unsupported by OpenCode V2`),
});

const guarded = async <T>(operation: string, fn: () => Promise<T>): Promise<LegacyResult<T>> => {
  try {
    return { data: await fn() };
  } catch (error) {
    if (error instanceof Error) return errorResult(operation, error);
    if (isFormNotFoundError(error)) return errorResult(operation, new Error(`QuestionNotFoundError: ${error.message}`));
    if (isPermissionNotFoundError(error)) return errorResult(operation, new Error(`PermissionNotFoundError: ${error.message}`));
    return errorResult(operation, new Error(`${operation}: ${JSON.stringify(error)}`));
  }
};

const location = (input: LocationInput | undefined, scopedDirectory: string | undefined): LocationRef | undefined => {
  const directory = input?.directory ?? scopedDirectory;
  return directory ? { directory } : undefined;
};

const requestOptions = (options?: LegacyOptions): LegacyOptions | undefined => options
  ? { signal: options.signal, headers: options.headers }
  : undefined;

const normalizeSession = (info: SessionInfo): Session => {
  const session: Session = {
    id: info.id,
    slug: info.id,
    projectID: info.projectID,
    directory: info.location.directory,
    cost: info.cost,
    tokens: info.tokens,
    title: info.title ?? info.id,
    version: '2',
    time: info.time,
  };
  if (info.location.workspaceID) session.workspaceID = info.location.workspaceID;
  if (info.subpath) session.path = info.subpath;
  if (info.parentID) session.parentID = info.parentID;
  if (info.agent) session.agent = info.agent;
  if (info.model) {
    session.model = { id: info.model.id, providerID: info.model.providerID };
    if (info.model.variant) session.model.variant = info.model.variant;
  }
  if (info.revert) {
    session.revert = { messageID: info.revert.messageID };
    if (info.revert.partID) session.revert.partID = info.revert.partID;
    if (info.revert.snapshot) session.revert.snapshot = info.revert.snapshot;
  }
  return session;
};

const normalizeCreatedSession = (event: Extract<EventSubscribeOutput, { type: 'session.created' }>): Session => {
  const session: Session = {
    id: event.data.sessionID,
    slug: event.data.slug,
    projectID: event.data.projectID,
    directory: event.data.location.directory,
    cost: 0,
    tokens: EMPTY_TOKENS,
    title: event.data.title ?? event.data.slug,
    version: event.data.version,
    time: { created: event.created, updated: event.created },
  };
  if (event.data.location.workspaceID) session.workspaceID = event.data.location.workspaceID;
  if (event.data.subpath) session.path = event.data.subpath;
  if (event.data.parentID) session.parentID = event.data.parentID;
  if (event.data.agent) session.agent = event.data.agent;
  if (event.data.model) {
    session.model = { id: event.data.model.id, providerID: event.data.model.providerID };
    if (event.data.model.variant) session.model.variant = event.data.model.variant;
  }
  return session;
};

const normalizeProject = (project: V2Project): Project => {
  const normalized: Project = {
    id: project.id,
    worktree: project.canonical,
    time: project.time,
    sandboxes: project.sandboxes,
  };
  if (project.vcs === 'git') normalized.vcs = project.vcs;
  if (project.name) normalized.name = project.name;
  if (project.icon) normalized.icon = project.icon;
  if (project.commands) normalized.commands = project.commands;
  return normalized;
};

const partID = (messageID: string, type: 'text' | 'reasoning', ordinal: number): string => `${messageID}:${type}:${ordinal}`;

const normalizeUserMessage = (sessionID: string, message: SessionMessageUser, session?: Session): NormalizedMessage => {
  const model = session?.model;
  const info: UserMessage = {
    id: message.id,
    sessionID,
    role: 'user',
    time: message.time,
    agent: session?.agent ?? '',
    model: { providerID: model?.providerID ?? '', modelID: model?.id ?? '' },
  };
  if (model?.variant) info.model.variant = model.variant;
  const parts: Part[] = [{ id: `${message.id}:text:0`, sessionID, messageID: message.id, type: 'text', text: message.text }];
  for (const [index, file] of (message.files ?? []).entries()) {
    const part: FilePart = { id: `${message.id}:file:${index}`, sessionID, messageID: message.id, type: 'file', mime: file.mime, url: file.source.type === 'uri' ? file.source.uri : `data:${file.mime};base64,${file.data}` };
    if (file.name) part.filename = file.name;
    parts.push(part);
  }
  for (const [index, agent] of (message.agents ?? []).entries()) {
    const part: Part = { id: `${message.id}:agent:${index}`, sessionID, messageID: message.id, type: 'agent', name: agent.name };
    if (agent.mention) part.source = { value: agent.mention.text, start: agent.mention.start, end: agent.mention.end };
    parts.push(part);
  }
  return { info, parts };
};

const toolOutput = (tool: SessionMessageAssistantTool): string => tool.state.status === 'completed'
  ? tool.state.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
  : '';

const toolAttachments = (sessionID: string, messageID: string, toolID: string, content: Extract<SessionMessageAssistantTool['state'], { status: 'completed' }>['content']): FilePart[] | undefined => {
  const files = content.flatMap((item) => item.type === 'file' ? [item] : []);
  if (files.length === 0) return undefined;
  return files.map((file, index) => {
    const part: FilePart = { id: `${toolID}:file:${index}`, sessionID, messageID, type: 'file', mime: file.mime, url: file.uri };
    if (file.name) part.filename = file.name;
    return part;
  });
};

const normalizeTool = (sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart => {
  const base = { id: tool.id, sessionID, messageID, type: 'tool' as const, callID: tool.id, tool: tool.name };
  if (tool.state.status === 'streaming') return { ...base, state: { status: 'pending', input: {}, raw: tool.state.input } };
  if (tool.state.status === 'running') return { ...base, state: { status: 'running', input: tool.state.input, metadata: tool.state.metadata, time: { start: tool.time.created } } };
  if (tool.state.status === 'error') {
    const state: Extract<ToolPart['state'], { status: 'error' }> = { status: 'error', input: tool.state.input, error: tool.state.error.message, time: { start: tool.time.created, end: tool.time.completed ?? tool.time.created } };
    if (tool.state.metadata) state.metadata = tool.state.metadata;
    return { ...base, state };
  }
  const state: Extract<ToolPart['state'], { status: 'completed' }> = { status: 'completed', input: tool.state.input, output: toolOutput(tool), title: tool.name, metadata: tool.state.metadata ?? {}, time: { start: tool.time.created, end: tool.time.completed ?? tool.time.created } };
  const attachments = toolAttachments(sessionID, messageID, tool.id, tool.state.content);
  if (attachments) state.attachments = attachments;
  return { ...base, state };
};

const normalizeAssistantMessage = (sessionID: string, message: SessionMessageAssistant, directory: string): NormalizedMessage => {
  const info: AssistantMessage = {
    id: message.id,
    sessionID,
    role: 'assistant',
    time: message.time,
    parentID: '',
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: directory, root: directory },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? EMPTY_TOKENS,
  };
  if (message.model.variant) info.variant = message.model.variant;
  if (message.finish) info.finish = message.finish;
  const parts: Part[] = [];
  for (const [index, content] of message.content.entries()) {
    if (content.type === 'text') parts.push({ id: partID(message.id, 'text', index), sessionID, messageID: message.id, type: 'text', text: content.text });
    else if (content.type === 'reasoning') {
      const time: ReasoningTime = { start: content.time?.created ?? message.time.created };
      if (content.time?.completed) time.end = content.time.completed;
      parts.push({ id: partID(message.id, 'reasoning', index), sessionID, messageID: message.id, type: 'reasoning', text: content.text, time });
    }
    else parts.push(normalizeTool(sessionID, message.id, content));
  }
  return { info, parts };
};

const normalizeMessage = (sessionID: string, message: SessionMessageInfo, session?: Session): NormalizedMessage | null => {
  if (message.type === 'user') return normalizeUserMessage(sessionID, message, session);
  if (message.type === 'assistant') return normalizeAssistantMessage(sessionID, message, session?.directory ?? '');
  return null;
};

const normalizePermission = (permission: V2PermissionRequest): PermissionRequest => {
  const normalized: PermissionRequest = {
    id: permission.id,
    sessionID: permission.sessionID,
    permission: permission.action,
    patterns: permission.resources,
    metadata: permission.metadata ?? {},
    always: permission.save ?? [],
  };
  if (permission.source) normalized.tool = { messageID: permission.source.messageID, callID: permission.source.id };
  return normalized;
};

const normalizeQuestion = (form: FormInfo): QuestionRequest => ({
  id: form.id,
  sessionID: form.sessionID,
  questions: form.fields.map((field): QuestionInfo => {
    const options = field.type === 'string' && field.options
      ? field.options.map((option) => ({ label: option.label, description: option.description ?? '' }))
      : field.type === 'multiselect'
        ? field.options.map((option) => ({ label: option.label, description: option.description ?? '' }))
        : [];
    const question: QuestionInfo = { question: field.description ?? field.title ?? field.key, header: field.title ?? form.title, options };
    if (field.type === 'multiselect') question.multiple = true;
    return question;
  }),
});

const answerValue = (field: FormField, answer: string[]): FormAnswer[string] => {
  const optionValue = (value: string): string => {
    if ((field.type !== 'string' && field.type !== 'multiselect') || !field.options) return value;
    const matches = new Set(field.options.filter((option) => option.value === value || option.label === value).map((option) => option.value));
    if (matches.size === 1) return matches.values().next().value ?? value;
    if (matches.size > 1) throw new Error(`Ambiguous option label "${value}" for form field ${field.key}`);
    if (field.custom) return value;
    throw new Error(`Unknown option "${value}" for form field ${field.key}`);
  };
  if (field.type === 'multiselect') return answer.map(optionValue);
  const first = answer[0] ?? '';
  if (field.type === 'boolean') return first === 'true';
  if (field.type === 'number' || field.type === 'integer') {
    const value = Number(first);
    return Number.isFinite(value) ? value : first;
  }
  return optionValue(first);
};

const modalities = (values: string[]): CompatibleModel['capabilities']['input'] => ({
  text: values.includes('text'),
  audio: values.includes('audio'),
  image: values.includes('image'),
  video: values.includes('video'),
  pdf: values.includes('pdf'),
});

const normalizeModel = (model: ModelInfo): CompatibleModel => {
  const normalized: CompatibleModel = {
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    capabilities: {
      attachment: model.capabilities.input.some((type) => type !== 'text'),
      toolcall: model.capabilities.tools,
      input: modalities(model.capabilities.input),
      output: modalities(model.capabilities.output),
    },
    limit: model.limit,
    status: model.status,
    options: model.settings,
    headers: model.headers,
    release_date: new Date(model.time.released).toISOString(),
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings])),
  };
  if (model.family) normalized.family = model.family;
  const baseCost = model.cost.find((cost) => cost.tier === undefined);
  if (baseCost) normalized.cost = { input: baseCost.input, output: baseCost.output, cache: baseCost.cache };
  return normalized;
};

const normalizeAgent = (agent: AgentInfo) => ({
  name: agent.name,
  description: agent.description,
  mode: agent.mode,
  hidden: agent.hidden,
  color: agent.color,
  permission: agent.permissions.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect })),
  model: agent.model ? { providerID: agent.model.providerID, modelID: agent.model.id } : undefined,
  variant: agent.model?.variant,
  prompt: agent.system,
  options: agent.request.settings,
  steps: agent.steps,
});

const normalizeFileEntry = (entry: FileSystemEntry) => ({ path: entry.path, type: entry.type });

const sessionIDOf = (event: EventSubscribeOutput): string | undefined => 'sessionID' in event.data ? event.data.sessionID : undefined;
const eventDirectory = (event: EventSubscribeOutput, scopedDirectory?: string): string => event.location?.directory ?? scopedDirectory ?? 'global';

export function createOpencode2Adapter(
  legacyClient: OpencodeClient,
  baseUrl: string,
  scopedDirectory: string | undefined,
  runtimeFetch: OpenCodeRuntimeFetch,
  detectProtocol: OpenCodeProtocolDetector,
): OpencodeClient {
  const permissionSessions = new Map<string, string>();
  const forms = new Map<string, RequestForm>();
  const sessions = new Map<string, Session>();
  const tools = new Map<string, ToolSnapshot>();
  const assistantMessages = new Map<string, AssistantMessage>();

  const fetchAdapter: typeof globalThis.fetch = async (input, init) => {
    const original = new Request(input, init);
    const url = new URL(original.url);
    if (url.pathname === '/api' || (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/api/'))) {
      url.pathname = `/api${url.pathname}`;
    }
    return runtimeFetch(new Request(url, original));
  };
  const v2 = OpenCode.make({ baseUrl, fetch: fetchAdapter });

  const rememberSession = (session: Session): Session => {
    sessions.set(session.id, session);
    return session;
  };

  const listV2Pages = async (input: SessionListInput, budget: { remaining: number }, parentID?: string | null): Promise<Session[]> => {
    const output: Session[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    while (budget.remaining > 0) {
      budget.remaining -= 1;
      const query: SessionListQuery = {
        limit: Math.min(input.limit ?? PAGE_LIMIT, PAGE_LIMIT),
        order: 'desc',
      };
      const directory = input.directory ?? scopedDirectory;
      if (directory) query.directory = directory;
      if (parentID !== undefined) query.parentID = parentID;
      if (cursor) query.cursor = cursor;
      const result = await v2.session.list(query);
      for (const item of result.data) output.push(rememberSession(normalizeSession(item)));
      const next = result.cursor.next ?? undefined;
      if (!next || seenCursors.has(next) || next === cursor) break;
      if (budget.remaining === 0) throw new Error('OpenCode V2 session pagination limit exceeded');
      seenCursors.add(next);
      cursor = next;
    }
    return output;
  };

  const listSessions = async (input: SessionListInput = {}): Promise<Session[]> => {
    const rootsOnly = input.roots === true || input.roots === 'true';
    const broad = input.roots === false || input.roots === 'false' || input.roots === undefined;
    const budget = { remaining: MAX_PAGES };
    const roots = await listV2Pages(input, budget, broad || rootsOnly ? null : undefined);
    const all = [...roots];
    if (broad && !rootsOnly) {
      const queue = [...roots];
      const visited = new Set(queue.map((session) => session.id));
      while (queue.length > 0 && all.length < MAX_DESCENDANTS) {
        const parent = queue.shift();
        if (!parent) break;
        const children = await listV2Pages(input, budget, parent.id);
        for (const child of children) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          all.push(child);
          queue.push(child);
        }
      }
      if (queue.length > 0) throw new Error('OpenCode V2 descendant session limit exceeded');
    }
    const includeArchived = input.archived === true || input.archived === 'true';
    return includeArchived ? all : all.filter((session) => !session.time.archived);
  };

  const sessionFromEvent = async (event: EventSubscribeOutput): Promise<Session> => {
    if (event.type === 'session.created') return rememberSession(normalizeCreatedSession(event));
    const id = sessionIDOf(event);
    if (!id) throw new Error(`${event.type} did not include a session ID`);
    return rememberSession(normalizeSession(await v2.session.get({ sessionID: id })));
  };

  const assistantInfo = (event: Extract<EventSubscribeOutput, { type: 'session.step.started' }>): AssistantMessage => {
    const directory = event.location?.directory ?? scopedDirectory ?? '';
    const info: AssistantMessage = {
      id: event.data.assistantMessageID,
      sessionID: event.data.sessionID,
      role: 'assistant',
      time: { created: event.created },
      parentID: '',
      modelID: event.data.model.id,
      providerID: event.data.model.providerID,
      mode: event.data.agent,
      agent: event.data.agent,
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: EMPTY_TOKENS,
    };
    if (event.data.model.variant) info.variant = event.data.model.variant;
    return info;
  };

  const rememberAssistant = (info: AssistantMessage): AssistantMessage => {
    assistantMessages.set(info.id, info);
    return info;
  };

  const finishAssistant = (
    event: Extract<EventSubscribeOutput, { type: 'session.step.ended' | 'session.step.failed' }>,
  ): AssistantMessage => {
    const existing = assistantMessages.get(event.data.assistantMessageID);
    const directory = event.location?.directory ?? scopedDirectory ?? '';
    const info: AssistantMessage = {
      ...(existing ?? {
        id: event.data.assistantMessageID,
        sessionID: event.data.sessionID,
        role: 'assistant',
        parentID: '',
        modelID: '',
        providerID: '',
        mode: '',
        agent: '',
        path: { cwd: directory, root: directory },
        time: { created: event.created },
        cost: 0,
        tokens: EMPTY_TOKENS,
      }),
      time: { created: existing?.time.created ?? event.created, completed: event.created },
      cost: event.data.cost ?? existing?.cost ?? 0,
      tokens: event.data.tokens ?? existing?.tokens ?? EMPTY_TOKENS,
    };
    if (event.type === 'session.step.ended') info.finish = event.data.finish;
    else info.error = { name: 'UnknownError', data: { message: event.data.error.message } };
    return rememberAssistant(info);
  };

  const toolPart = (event: EventSubscribeOutput, state: ToolPart['state']): Event => {
    const data = event.data;
    if (!('sessionID' in data) || !('assistantMessageID' in data) || !('id' in data)) throw new Error(`Malformed ${event.type}`);
    const snapshot = tools.get(data.id);
    const time = 'created' in event ? event.created : 0;
    return { id: event.id, type: 'message.part.updated', properties: { sessionID: data.sessionID, part: { id: data.id, sessionID: data.sessionID, messageID: data.assistantMessageID, type: 'tool', callID: data.id, tool: snapshot?.name ?? '', state }, time } };
  };

  const mapEvent = async (event: EventSubscribeOutput): Promise<Event | null> => {
    switch (event.type) {
      case 'session.created':
        return { id: event.id, type: 'session.created', properties: { sessionID: event.data.sessionID, info: await sessionFromEvent(event) } };
      case 'session.renamed':
      case 'session.agent.selected':
      case 'session.model.selected':
      case 'session.moved':
        return { id: event.id, type: 'session.updated', properties: { sessionID: event.data.sessionID, info: await sessionFromEvent(event) } };
      case 'session.deleted': {
        const cached = sessions.get(event.data.sessionID);
        if (cached) return { id: event.id, type: 'session.deleted', properties: { sessionID: cached.id, info: cached } };
        const directory = event.location?.directory ?? scopedDirectory ?? '';
        const fallback: Session = {
          id: event.data.sessionID,
          slug: event.data.sessionID,
          projectID: '',
          directory,
          cost: 0,
          tokens: EMPTY_TOKENS,
          title: event.data.sessionID,
          version: '2',
          time: { created: event.created, updated: event.created },
        };
        return { id: event.id, type: 'session.deleted', properties: { sessionID: fallback.id, info: fallback } };
      }
      case 'session.status':
        return { id: event.id, type: 'session.status', properties: { sessionID: event.data.sessionID, status: event.data.status } };
      case 'session.idle':
      case 'session.execution.succeeded':
        return { id: event.id, type: 'session.idle', properties: { sessionID: event.data.sessionID } };
      case 'session.execution.started':
        return { id: event.id, type: 'session.status', properties: { sessionID: event.data.sessionID, status: { type: 'busy' } } };
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        return { id: event.id, type: 'session.error', properties: { sessionID: event.data.sessionID, error: event.type === 'session.execution.failed' ? { name: 'UnknownError', data: { message: event.data.error.message } } : { name: 'MessageAbortedError', data: { message: event.data.reason } } } };
      case 'session.step.started':
        return { id: event.id, type: 'message.updated', properties: { sessionID: event.data.sessionID, info: rememberAssistant(assistantInfo(event)) } };
      case 'session.step.ended':
      case 'session.step.failed':
        return { id: event.id, type: 'message.updated', properties: { sessionID: event.data.sessionID, info: finishAssistant(event) } };
      case 'session.text.started':
        return { id: event.id, type: 'message.part.updated', properties: { sessionID: event.data.sessionID, part: { id: partID(event.data.assistantMessageID, 'text', event.data.ordinal), sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, type: 'text', text: '', time: { start: event.created } }, time: event.created } };
      case 'session.text.delta':
        return { id: event.id, type: 'message.part.delta', properties: { sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, partID: partID(event.data.assistantMessageID, 'text', event.data.ordinal), field: 'text', delta: event.data.delta } };
      case 'session.text.ended':
        return { id: event.id, type: 'message.part.updated', properties: { sessionID: event.data.sessionID, part: { id: partID(event.data.assistantMessageID, 'text', event.data.ordinal), sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, type: 'text', text: event.data.text, time: { start: event.created, end: event.created } }, time: event.created } };
      case 'session.reasoning.started':
        return { id: event.id, type: 'message.part.updated', properties: { sessionID: event.data.sessionID, part: { id: partID(event.data.assistantMessageID, 'reasoning', event.data.ordinal), sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, type: 'reasoning', text: '', time: { start: event.created } }, time: event.created } };
      case 'session.reasoning.delta':
        return { id: event.id, type: 'message.part.delta', properties: { sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, partID: partID(event.data.assistantMessageID, 'reasoning', event.data.ordinal), field: 'text', delta: event.data.delta } };
      case 'session.reasoning.ended':
        return { id: event.id, type: 'message.part.updated', properties: { sessionID: event.data.sessionID, part: { id: partID(event.data.assistantMessageID, 'reasoning', event.data.ordinal), sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, type: 'reasoning', text: event.data.text, time: { start: event.created, end: event.created } }, time: event.created } };
      case 'session.tool.input.started': {
        tools.set(event.data.id, { sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, name: event.data.name, input: {}, started: event.created, raw: '' });
        return toolPart(event, { status: 'pending', input: {}, raw: '' });
      }
      case 'session.tool.input.delta': {
        const snapshot = tools.get(event.data.id);
        if (snapshot) snapshot.raw += event.data.delta;
        return toolPart(event, { status: 'pending', input: snapshot?.input ?? {}, raw: snapshot?.raw ?? event.data.delta });
      }
      case 'session.tool.input.ended': {
        const snapshot = tools.get(event.data.id);
        return toolPart(event, { status: 'running', input: snapshot?.input ?? {}, time: { start: snapshot?.started ?? event.created } });
      }
      case 'session.tool.called': {
        const current = tools.get(event.data.id);
        const snapshot: ToolSnapshot = { sessionID: event.data.sessionID, messageID: event.data.assistantMessageID, name: current?.name ?? '', input: event.data.input, started: current?.started ?? event.created, raw: current?.raw ?? '' };
        tools.set(event.data.id, snapshot);
        return toolPart(event, { status: 'running', input: snapshot.input, time: { start: snapshot.started } });
      }
      case 'session.tool.progress': {
        const snapshot = tools.get(event.data.id);
        if (snapshot) snapshot.metadata = event.data.metadata;
        return toolPart(event, { status: 'running', input: snapshot?.input ?? {}, metadata: event.data.metadata, time: { start: snapshot?.started ?? event.created } });
      }
      case 'session.tool.success': {
        const snapshot = tools.get(event.data.id);
        const output = event.data.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
        const state: Extract<ToolPart['state'], { status: 'completed' }> = { status: 'completed', input: snapshot?.input ?? {}, output, title: snapshot?.name ?? '', metadata: event.data.metadata ?? {}, time: { start: snapshot?.started ?? event.created, end: event.created } };
        const attachments = toolAttachments(event.data.sessionID, event.data.assistantMessageID, event.data.id, event.data.content);
        if (attachments) state.attachments = attachments;
        const mapped = toolPart(event, state);
        tools.delete(event.data.id);
        return mapped;
      }
      case 'session.tool.failed': {
        const snapshot = tools.get(event.data.id);
        const state: Extract<ToolPart['state'], { status: 'error' }> = { status: 'error', input: snapshot?.input ?? {}, error: event.data.error.message, time: { start: snapshot?.started ?? event.created, end: event.created } };
        if (event.data.metadata) state.metadata = event.data.metadata;
        const mapped = toolPart(event, state);
        tools.delete(event.data.id);
        return mapped;
      }
      case 'permission.asked': {
        permissionSessions.set(event.data.id, event.data.sessionID);
        return { id: event.id, type: 'permission.asked', properties: normalizePermission(event.data) };
      }
      case 'permission.replied':
        permissionSessions.delete(event.data.requestID);
        return { id: event.id, type: 'permission.replied', properties: { sessionID: event.data.sessionID, requestID: event.data.requestID, reply: event.data.reply } };
      case 'form.created': {
        forms.set(event.data.form.id, { sessionID: event.data.form.sessionID, fields: event.data.form.fields });
        return { id: event.id, type: 'question.asked', properties: normalizeQuestion(event.data.form) };
      }
      case 'form.replied':
        forms.delete(event.data.id);
        return { id: event.id, type: 'question.replied', properties: { sessionID: event.data.sessionID, requestID: event.data.id, answers: [] } };
      case 'form.cancelled':
        forms.delete(event.data.id);
        return { id: event.id, type: 'question.rejected', properties: { sessionID: event.data.sessionID, requestID: event.data.id } };
      case 'vcs.branch.updated':
        return { id: event.id, type: 'vcs.branch.updated', properties: { branch: event.data.branch ?? '' } };
      default:
        return null;
    }
  };

  const handlers = new Map<string, (...args: never[]) => Promise<AdapterCallResult>>([
    ['path.get', async (input?: LocationInput, options?: LegacyOptions) => guarded('path.get', async () => {
      const result = await v2.location.get({ location: location(input, scopedDirectory) }, requestOptions(options));
      return { home: result.directory, state: result.directory, config: result.directory, worktree: result.project.directory, directory: result.directory };
    })],
    ['project.list', async (_input?: LocationInput, options?: LegacyOptions) => guarded('project.list', async () => (await v2.project.list(requestOptions(options))).map(normalizeProject))],
    ['project.current', async (input?: LocationInput, options?: LegacyOptions) => guarded('project.current', async () => {
      const result = await v2.project.current({ location: location(input, scopedDirectory) }, requestOptions(options));
      return { id: result.id, worktree: result.directory, time: { created: 0, updated: 0 }, sandboxes: [] };
    })],
    ['session.list', async (input: SessionListInput = {}) => guarded('session.list', () => listSessions(input))],
    ['experimental.session.list', async (input: SessionListInput = {}) => {
      if (input.cursor !== undefined) return { data: [] };
      return guarded('experimental.session.list', () => listSessions(input));
    }],
    ['session.get', async (input: SessionInput, options?: LegacyOptions) => guarded('session.get', async () => rememberSession(normalizeSession(await v2.session.get({ sessionID: input.sessionID }, requestOptions(options)))))],
    ['session.create', async (input: SessionCreateInput = {}, options?: LegacyOptions) => {
      if (input.parentID) return errorResult('session.create', new Error('OpenCode V2 does not support creating a child session without a fork boundary'));
      return guarded('session.create', async () => {
        const request: MutableSessionCreateInput = {};
        if (input.title) request.title = input.title;
        if (input.agent) request.agent = input.agent;
        if (input.model) {
          if (input.model.variant) request.model = { providerID: input.model.providerID, id: input.model.id ?? input.model.modelID ?? '', variant: input.model.variant };
          else request.model = { providerID: input.model.providerID, id: input.model.id ?? input.model.modelID ?? '' };
        }
        const requestLocation = location(input, scopedDirectory);
        if (requestLocation) request.location = requestLocation;
        return rememberSession(normalizeSession(await v2.session.create(request, requestOptions(options))));
      });
    }],
    ['session.delete', async (input: SessionInput, options?: LegacyOptions) => guarded('session.delete', async () => { await v2.session.remove({ sessionID: input.sessionID }, requestOptions(options)); sessions.delete(input.sessionID); return true; })],
    ['session.update', async (input: SessionUpdateInput, options?: LegacyOptions) => {
      if (input.title === undefined || input.metadata !== undefined || input.permission !== undefined || input.time !== undefined) {
        return errorResult('session.update', new Error('OpenCode V2 only supports title-only session.update patches'));
      }
      const title = input.title;
      return guarded('session.update', async () => {
        await v2.session.rename({ sessionID: input.sessionID, title }, requestOptions(options));
        return rememberSession(normalizeSession(await v2.session.get({ sessionID: input.sessionID }, requestOptions(options))));
      });
    }],
    ['experimental.controlPlane.moveSession', async (input: SessionMoveActionInput, options?: LegacyOptions) => {
      if (input.moveChanges !== false) return errorResult('experimental.controlPlane.moveSession', new Error('OpenCode V2 session.move cannot authoritatively transfer local changes'));
      return guarded('experimental.controlPlane.moveSession', async () => { await v2.session.move({ sessionID: input.sessionID, directory: input.destination.directory }, requestOptions(options)); });
    }],
    ['session.messages', async (input: SessionMessagesInput, options?: LegacyOptions) => {
      try {
        const result = await v2.message.list({ sessionID: input.sessionID, limit: input.limit, order: 'desc', cursor: input.before }, requestOptions(options));
        let session = sessions.get(input.sessionID);
        if (!session) session = rememberSession(normalizeSession(await v2.session.get({ sessionID: input.sessionID }, requestOptions(options))));
        const data = result.data.map((message) => normalizeMessage(input.sessionID, message, session)).filter((message) => message !== null);
        const next = result.cursor.next ?? result.cursor.previous;
        const response: LegacyResult<typeof data> = { data };
        if (next) response.response = new Response(null, { headers: { 'x-next-cursor': next } });
        return response;
      } catch (error) {
        if (error instanceof Error) return errorResult('session.messages', error);
        if (isFormNotFoundError(error)) return errorResult('session.messages', new Error(`QuestionNotFoundError: ${error.message}`));
        if (isPermissionNotFoundError(error)) return errorResult('session.messages', new Error(`PermissionNotFoundError: ${error.message}`));
        return errorResult('session.messages', new Error(`session.messages: ${JSON.stringify(error)}`));
      }
    }],
    ['session.promptAsync', async (input: SessionPromptInput, options?: LegacyOptions) => guarded('session.promptAsync', async () => {
        if (input.format) throw new Error('OpenCode V2 does not support structured prompt output');
        const previousSession = input.agent && input.model
          ? await v2.session.get({ sessionID: input.sessionID }, requestOptions(options))
          : undefined;
        if (input.agent) await v2.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, requestOptions(options));
        try {
          if (input.model) {
            if (input.variant) await v2.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID, variant: input.variant } }, requestOptions(options));
            else await v2.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } }, requestOptions(options));
          }
        } catch (error) {
          if (previousSession?.agent) {
            try {
              await v2.session.switchAgent({ sessionID: input.sessionID, agent: previousSession.agent }, requestOptions(options));
            } catch (rollbackError) {
              sessions.delete(input.sessionID);
              try {
                rememberSession(normalizeSession(await v2.session.get({ sessionID: input.sessionID }, requestOptions(options))));
              } catch (refreshError) {
                throw new AggregateError(
                  [error, rollbackError, refreshError],
                  'OpenCode V2 model switch failed, agent rollback failed, and session state could not be refreshed',
                );
              }
              throw new AggregateError(
                [error, rollbackError],
                'OpenCode V2 model switch failed and agent rollback failed; session state was refreshed',
              );
            }
          }
          throw error;
        }
        const text = (input.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const files = (input.parts ?? []).filter((part) => part.type === 'file').map((part) => {
          if (part.filename) return { uri: part.url, name: part.filename } satisfies PromptFile;
          return { uri: part.url } satisfies PromptFile;
        });
        const agents = (input.parts ?? []).filter((part) => part.type === 'agent').map((part) => {
          if (part.source) return { name: part.name, mention: { start: part.source.start, end: part.source.end, text: part.source.value } } satisfies PromptAgent;
          return { name: part.name } satisfies PromptAgent;
        });
        const prompt: MutableSessionPromptInput = { sessionID: input.sessionID, id: input.messageID, text };
        if (files.length) prompt.files = files;
        if (agents.length) prompt.agents = agents;
        if (input.delivery) prompt.delivery = input.delivery;
        await v2.session.prompt(prompt, requestOptions(options));
        return true;
    })],
    ['session.command', async (input: SessionCommandInput, options?: LegacyOptions) => {
      const separator = input.model?.indexOf('/') ?? -1;
      if (input.model && separator <= 0) return errorResult('session.command', new Error('OpenCode V2 requires command models in provider/model form'));
      return guarded('session.command', async () => {
        let model: ModelRef | undefined;
        if (input.model) {
          model = { providerID: input.model.slice(0, separator), id: input.model.slice(separator + 1) };
          if (input.variant) model.variant = input.variant;
        }
        return v2.session.command({
          sessionID: input.sessionID,
          id: input.messageID,
          command: input.command,
          arguments: input.arguments,
          agent: input.agent,
          model,
          files: input.parts?.map((part) => part.filename ? { uri: part.url, name: part.filename } : { uri: part.url }),
        }, requestOptions(options));
      });
    }],
    ['session.fork', async (input: SessionForkInput, options?: LegacyOptions) => guarded('session.fork', async () => {
      const boundary = input.messageID ? { type: 'before' as const, messageID: input.messageID } : { type: 'through' as const };
      return rememberSession(normalizeSession(await v2.session.fork({ sessionID: input.sessionID, boundary }, requestOptions(options))));
    })],
    ['session.summarize', async (input: SessionSummarizeInput, options?: LegacyOptions) => guarded('session.summarize', async () => {
      const session = await v2.session.get({ sessionID: input.sessionID }, requestOptions(options));
      if (session.model?.providerID !== input.providerID || session.model.id !== input.modelID) {
        throw new Error('OpenCode V2 compact can only use the session selected model');
      }
      await v2.session.compact({ sessionID: input.sessionID }, requestOptions(options));
      return true;
    })],
    ['session.revert', async (input: SessionRevertInput, options?: LegacyOptions) => {
      if (input.partID) return errorResult('session.revert', new Error('OpenCode V2 revert.stage does not support part-level boundaries'));
      return guarded('session.revert', async () => {
        await v2.session.revert.stage({ sessionID: input.sessionID, messageID: input.messageID, files: true }, requestOptions(options));
        return rememberSession(normalizeSession(await v2.session.get({ sessionID: input.sessionID }, requestOptions(options))));
      });
    }],
    ['session.unrevert', async (input: SessionInput, options?: LegacyOptions) => guarded('session.unrevert', async () => {
      await v2.session.revert.clear({ sessionID: input.sessionID }, requestOptions(options));
      return rememberSession(normalizeSession(await v2.session.get({ sessionID: input.sessionID }, requestOptions(options))));
    })],
    ['session.abort', async (input: SessionInput, options?: LegacyOptions) => guarded('session.abort', async () => { await v2.session.interrupt({ sessionID: input.sessionID }, requestOptions(options)); return true; })],
    ['config.providers', async (input?: LocationInput, options?: LegacyOptions) => guarded('config.providers', async () => {
      const request = { location: location(input, scopedDirectory) };
      const [providerResult, modelResult, defaultResult] = await Promise.all([
        v2.provider.list(request, requestOptions(options)),
        v2.model.list(request, requestOptions(options)),
        v2.model.default(request, requestOptions(options)),
      ]);
      const providers: CompatibleProvider[] = providerResult.data.map((provider) => ({
        id: provider.id,
        name: provider.name,
        options: provider.settings,
        models: {},
      }));
      const providersByID = new Map(providers.map((provider) => [provider.id, provider]));
      for (const model of modelResult.data) {
        const provider = providersByID.get(model.providerID);
        if (provider) provider.models[model.id] = normalizeModel(model);
      }
      const defaults = defaultResult.data ? { [defaultResult.data.providerID]: defaultResult.data.id } : {};
      return { providers, default: defaults };
    })],
    ['app.agents', async (input?: LocationInput, options?: LegacyOptions) => guarded('app.agents', async () => {
      const result = await v2.agent.list({ location: location(input, scopedDirectory) }, requestOptions(options));
      return result.data.map(normalizeAgent);
    })],
    ['file.read', async (input: LocationInput & { path: string }, options?: LegacyOptions) => guarded('file.read', async () => {
      const content = await v2.file.read({ path: input.path, location: location(input, scopedDirectory) }, requestOptions(options));
      return new TextDecoder().decode(content);
    })],
    ['file.list', async (input: LocationInput & { path?: string } = {}, options?: LegacyOptions) => guarded('file.list', async () => {
      const result = await v2.file.list({ path: input.path, location: location(input, scopedDirectory) }, requestOptions(options));
      return result.data.map(normalizeFileEntry);
    })],
    ['app.skills', async (input?: LocationInput, options?: LegacyOptions) => guarded('app.skills', async () => {
      const result = await v2.skill.list({ location: location(input, scopedDirectory) }, requestOptions(options));
      return result.data;
    })],
    ['permission.list', async (input?: LocationInput, options?: LegacyOptions) => guarded('permission.list', async () => {
      const result = await v2.permission.request.list({ location: location(input, scopedDirectory) }, requestOptions(options));
      return result.data.map((permission) => { permissionSessions.set(permission.id, permission.sessionID); return normalizePermission(permission); });
    })],
    ['permission.reply', async (input: PermissionReplyInput, options?: LegacyOptions) => {
      const sessionID = permissionSessions.get(input.requestID);
      if (!sessionID) return errorResult('permission.reply', new Error(`No session mapping for permission ${input.requestID}`));
      return guarded('permission.reply', async () => { await v2.permission.reply({ sessionID, requestID: input.requestID, reply: input.reply ?? 'reject', message: input.message }, requestOptions(options)); permissionSessions.delete(input.requestID); return true; });
    }],
    ['question.list', async (input?: LocationInput, options?: LegacyOptions) => guarded('question.list', async () => {
      const result = await v2.form.request.list({ location: location(input, scopedDirectory) }, requestOptions(options));
      return result.data.map((form) => { forms.set(form.id, { sessionID: form.sessionID, fields: form.fields }); return normalizeQuestion(form); });
    })],
    ['question.reply', async (input: QuestionReplyInput, options?: LegacyOptions) => {
      const form = forms.get(input.requestID);
      if (!form) return errorResult('question.reply', new Error(`No form mapping for question ${input.requestID}`));
      return guarded('question.reply', async () => {
        const answer: FormAnswer = {};
        form.fields.forEach((field, index) => { answer[field.key] = answerValue(field, input.answers?.[index] ?? []); });
        await v2.form.reply({ sessionID: form.sessionID, formID: input.requestID, answer }, requestOptions(options));
        forms.delete(input.requestID);
        return true;
      });
    }],
    ['question.reject', async (input: { requestID: string }, options?: LegacyOptions) => {
      const form = forms.get(input.requestID);
      if (!form) return errorResult('question.reject', new Error(`No form mapping for question ${input.requestID}`));
      return guarded('question.reject', async () => { await v2.form.cancel({ sessionID: form.sessionID, formID: input.requestID }, requestOptions(options)); forms.delete(input.requestID); return true; });
    }],
    ['command.list', async (input?: LocationInput, options?: LegacyOptions) => guarded('command.list', async () => {
      const result = await v2.command.list({ location: location(input, scopedDirectory) }, requestOptions(options));
      return result.data.map((command) => {
        const normalized: NormalizedCommand = { name: command.name, template: command.template, hints: [] };
        if (command.description) normalized.description = command.description;
        if (command.agent) normalized.agent = command.agent;
        if (command.model) normalized.model = `${command.model.providerID}/${command.model.id}`;
        if (command.subtask !== undefined) normalized.subtask = command.subtask;
        return normalized;
      });
    })],
    ['mcp.status', async (input?: LocationInput, options?: LegacyOptions) => guarded('mcp.status', async () => {
      const result = await v2.mcp.list({ location: location(input, scopedDirectory) }, requestOptions(options));
      return Object.fromEntries(result.data.map((server) => [server.name, server.status]));
    })],
    ['vcs.get', async (input?: LocationInput, options?: LegacyOptions) => guarded('vcs.get', async () => {
      const result = await v2.vcs.get({ location: location(input, scopedDirectory) }, requestOptions(options));
      const vcs: VcsResult = {};
      if (result.data.branch.current) vcs.branch = result.data.branch.current;
      if (result.data.branch.default) vcs.default_branch = result.data.branch.default;
      return vcs;
    })],
    ['global.event', async (options?: LegacyOptions) => {
      try {
        const source = v2.event.subscribe(requestOptions(options));
        const stream = (async function* (): AsyncGenerator<GlobalEvent> {
          for await (const event of source) {
            const payload = await mapEvent(event);
            if (payload) yield { directory: eventDirectory(event, scopedDirectory), payload };
          }
        })();
        return { stream };
      } catch (error) {
        if (error instanceof Error) return errorResult('global.event', error);
        if (isFormNotFoundError(error)) return errorResult('global.event', new Error(`QuestionNotFoundError: ${error.message}`));
        if (isPermissionNotFoundError(error)) return errorResult('global.event', new Error(`PermissionNotFoundError: ${error.message}`));
        return errorResult('global.event', new Error(`global.event: ${JSON.stringify(error)}`));
      }
    }],
  ]);

  const unsupportedAuthority = new Set(['config.get', 'global.config.get', 'session.status', 'session.todo', 'lsp.status']);
  const proxies = new Map<string, object>();
  const wrap = <Target extends object>(target: Target, path: string): Target => {
    const cached = proxies.get(path);
    if (cached) {
      // SAFETY: cached proxies wrap this exact target and preserve its public shape.
      return cached as Target;
    }
    const proxy = new Proxy(target, {
      get(current, property) {
        // SAFETY: Proxy keys are keys of the object being accessed.
        const value = current[property as keyof Target];
        if (!(Object(property) instanceof String)) return value;
        const name = String(property);
        const nextPath = path ? `${path}.${name}` : name;
        if (value instanceof Function) {
          return async (...args: never[]) => {
            let protocol: OpenCodeProtocol;
            try {
              protocol = await detectProtocol();
            } catch (error) {
              if (error instanceof Error) return errorResult(nextPath, error);
              if (isFormNotFoundError(error)) return errorResult(nextPath, new Error(`QuestionNotFoundError: ${error.message}`));
              if (isPermissionNotFoundError(error)) return errorResult(nextPath, new Error(`PermissionNotFoundError: ${error.message}`));
              return errorResult(nextPath, new Error(`${nextPath}: ${JSON.stringify(error)}`));
            }
            if (protocol === 'legacy') return value.call(current, ...args);
            const handler = handlers.get(nextPath);
            if (handler) return handler(...args);
            return errorResult(nextPath, new Error(unsupportedAuthority.has(nextPath) ? `${nextPath} has no authoritative OpenCode V2 equivalent` : `${nextPath} is unsupported by the OpenCode V2 adapter`));
          };
        }
        if (value instanceof Object) return wrap(value, nextPath);
        return value;
      },
    });
    proxies.set(path, proxy);
    return proxy;
  };

  const client = wrap(legacyClient, '');
  protocolDetectors.set(client, detectProtocol);
  return client;
}
