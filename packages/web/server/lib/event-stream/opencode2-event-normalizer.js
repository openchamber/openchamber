const valueTag = (value) => Object.prototype.toString.call(value);

const isObject = (value) => valueTag(value) === '[object Object]';

const isString = (value) => valueTag(value) === '[object String]';

const isNumber = (value) => Number.isFinite(value);

const stringValue = (value) => isString(value) ? value : undefined;

const numberValue = (value) => isNumber(value) ? value : undefined;

const assignWhen = (target, key, value, enabled) => {
  if (enabled) target[key] = value;
  return target;
};

const eventData = (payload) => {
  if (isObject(payload?.data)) return payload.data;
  if (isObject(payload?.properties)) return payload.properties;
  return null;
};

const errorMessage = (error) => {
  if (isString(error)) return error;
  if (!isObject(error)) return '';
  if (isString(error.message)) return error.message;
  if (isObject(error.data) && isString(error.data.message)) return error.data.message;
  return '';
};

const normalizeError = (error) => {
  if (isObject(error) && isString(error.name) && isObject(error.data)) return error;
  return { name: 'UnknownError', data: { message: errorMessage(error) } };
};

const normalizeModel = (model) => {
  if (!isObject(model) || !isString(model.id) || !isString(model.providerID)) return undefined;
  const normalized = {
    id: model.id,
    providerID: model.providerID,
  };
  return assignWhen(normalized, 'variant', model.variant, isString(model.variant));
};

const eventDirectory = (envelope, payload, data) => {
  if (isString(payload?.location?.directory) && payload.location.directory.length > 0) {
    return payload.location.directory;
  }
  if (payload?.type === 'session.moved' || payload?.type === 'session.next.moved') {
    if (isString(data?.location?.directory) && data.location.directory.length > 0) {
      return data.location.directory;
    }
  }
  if (isString(envelope?.directory) && envelope.directory.length > 0) return envelope.directory;
  if (isString(data?.location?.directory) && data.location.directory.length > 0) return data.location.directory;
  if (isString(payload?.directory) && payload.directory.length > 0) return payload.directory;
  if (isString(data?.directory) && data.directory.length > 0) return data.directory;
  if (isString(payload?.properties?.directory) && payload.properties.directory.length > 0) return payload.properties.directory;
  if (isString(payload?.properties?.info?.directory) && payload.properties.info.directory.length > 0) return payload.properties.info.directory;
  return 'global';
};

const addDirectory = (properties, directory) => {
  if (directory === 'global' || !isObject(properties) || properties.directory) return properties;
  return { ...properties, directory };
};

const fallbackSession = (sessionID, directory, created) => ({
  id: sessionID,
  slug: sessionID,
  projectID: '',
  directory: directory === 'global' ? '' : directory,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: sessionID,
  version: '2',
  time: { created, updated: created },
});

const sessionInfoFromCreatedEvent = (data, directory, created) => {
  const location = isObject(data.location) ? data.location : {};
  const sessionDirectory = isString(location.directory) && location.directory.length > 0
    ? location.directory
    : directory === 'global' ? '' : directory;
  const info = {
    id: data.sessionID,
    slug: isString(data.slug) ? data.slug : data.sessionID,
    projectID: isString(data.projectID) ? data.projectID : '',
    directory: sessionDirectory,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: isString(data.title) ? data.title : (data.slug || data.sessionID),
    version: isString(data.version) ? data.version : '2',
    time: { created, updated: created },
  };
  if (isString(location.workspaceID)) info.workspaceID = location.workspaceID;
  if (isString(data.subpath) && data.subpath.length > 0) info.path = data.subpath;
  if (isString(data.subdirectory) && data.subdirectory.length > 0) info.path = data.subdirectory;
  if (isString(data.parentID) && data.parentID.length > 0) info.parentID = data.parentID;
  if (isString(data.agent)) info.agent = data.agent;
  const model = normalizeModel(data.model);
  if (model) info.model = model;
  return info;
};

const sessionInfoFromUpdateEvent = (data, directory, type, created, sessions) => {
  const sessionID = isString(data.sessionID) ? data.sessionID : '';
  if (!sessionID) return null;

  const previous = sessions.get(sessionID);
  const info = {
    ...(previous ?? fallbackSession(sessionID, directory, created)),
    time: {
      ...(previous?.time ?? { created, updated: created }),
      updated: created,
    },
  };

  if (type === 'session.renamed' && isString(data.title)) info.title = data.title;
  if (type === 'session.agent.selected' && isString(data.agent)) info.agent = data.agent;
  if (type === 'session.model.selected') {
    const model = normalizeModel(data.model);
    if (model) info.model = model;
  }
  if (type === 'session.moved') {
    const location = isObject(data.location) ? data.location : {};
    if (isString(location.directory) && location.directory.length > 0) info.directory = location.directory;
    if (isString(location.workspaceID)) info.workspaceID = location.workspaceID;
    if (isString(data.projectID) && data.projectID.length > 0) info.projectID = data.projectID;
    if (isString(data.subpath)) info.path = data.subpath;
    if (isString(data.subdirectory)) info.path = data.subdirectory;
  }
  if (!info.directory) info.directory = directory === 'global' ? '' : directory;
  sessions.set(sessionID, info);
  return info;
};

const normalizeQuestion = (form) => ({
  id: form.id,
  sessionID: form.sessionID,
  questions: Array.isArray(form.fields)
    ? form.fields.filter(isObject).map((field) => {
      const options = (field.type === 'string' || field.type === 'multiselect') && Array.isArray(field.options)
        ? field.options.filter(isObject).map((option) => ({ label: option.label, description: option.description ?? '' }))
        : [];
      const question = {
        question: field.description ?? field.title ?? field.key ?? '',
        header: field.title ?? form.title ?? '',
        options,
      };
      return assignWhen(question, 'multiple', true, field.type === 'multiselect');
    })
    : [],
});

const normalizePermission = (data) => ({
  id: data.id,
  sessionID: data.sessionID,
  permission: data.action ?? data.permission,
  patterns: data.resources ?? data.patterns ?? [],
  metadata: data.metadata ?? {},
  always: data.save ?? data.always ?? [],
  ...(isObject(data.source)
    ? { tool: { messageID: data.source.messageID, callID: data.source.id ?? data.source.callID } }
    : isObject(data.tool) ? { tool: data.tool } : {}),
});

const assistantInfo = (data, directory, created) => {
  const model = normalizeModel(data.model);
  const info = {
    id: data.assistantMessageID,
    sessionID: data.sessionID,
    role: 'assistant',
    time: { created },
    parentID: '',
    modelID: model?.id ?? '',
    providerID: model?.providerID ?? '',
    mode: isString(data.agent) ? data.agent : '',
    agent: isString(data.agent) ? data.agent : '',
    path: { cwd: directory === 'global' ? '' : directory, root: directory === 'global' ? '' : directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  if (model?.variant) info.variant = model.variant;
  return info;
};

const finishAssistant = (data, directory, created, assistants, failed) => {
  const existing = assistants.get(data.assistantMessageID);
  const info = {
    ...(existing ?? assistantInfo({ ...data, agent: '', model: {} }, directory, created)),
    time: { created: existing?.time.created ?? created, completed: created },
  };
  if (failed) {
    info.finish = 'error';
    info.error = normalizeError(data.error);
  } else {
    info.finish = data.finish;
    info.cost = numberValue(data.cost) ?? existing?.cost ?? 0;
    info.tokens = data.tokens ?? existing?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  }
  assistants.delete(data.assistantMessageID);
  return info;
};

const partID = (data, kind) => {
  const directID = kind === 'text' ? data.textID : data.reasoningID;
  if (isString(directID) && directID.length > 0) return directID;
  const ordinal = isNumber(data.ordinal) ? data.ordinal : 0;
  return `${data.assistantMessageID}:${kind}:${ordinal}`;
};

const toolID = (data) => isString(data.callID) ? data.callID : data.id;

const toolOutput = (content) => Array.isArray(content)
  ? content.filter((item) => item?.type === 'text' && isString(item.text)).map((item) => item.text).join('\n')
  : '';

const toolAttachments = (sessionID, messageID, id, content) => {
  if (!Array.isArray(content)) return undefined;
  const files = content.filter((item) => item?.type === 'file' && isString(item.uri));
  if (files.length === 0) return undefined;
  return files.map((file, index) => {
    const attachment = {
      id: `${id}:file:${index}`,
      sessionID,
      messageID,
      type: 'file',
      mime: isString(file.mime) ? file.mime : 'application/octet-stream',
      url: file.uri,
    };
    return assignWhen(attachment, 'filename', file.name, isString(file.name));
  });
};

const partEvent = (eventID, data, state, created, tools) => {
  const id = toolID(data);
  if (!isString(id) || !isString(data.sessionID) || !isString(data.assistantMessageID)) return null;
  const snapshot = tools.get(id);
  return {
    id: eventID,
    type: 'message.part.updated',
    properties: {
      sessionID: data.sessionID,
      part: {
        id,
        sessionID: data.sessionID,
        messageID: data.assistantMessageID,
        type: 'tool',
        callID: id,
        tool: snapshot?.name ?? (isString(data.tool) ? data.tool : ''),
        state,
      },
      time: created,
    },
  };
};

const LEGACY_EVENT_TYPES = new Set([
  'server.connected',
  'server.instance.disposed',
  'session.created',
  'session.updated',
  'session.deleted',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.removed',
  'message.part.delta',
  'session.status',
  'session.idle',
  'session.compacted',
  'session.error',
  'session.diff',
  'todo.updated',
  'vcs.branch.updated',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'lsp.updated',
  'project.updated',
  'project.directories.updated',
  'file.watcher.updated',
  'installation.updated',
  'installation.update-available',
  'reference.updated',
  'integration.updated',
  'integration.connection.updated',
  'catalog.updated',
  'plugin.added',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'vcs.branch.updated',
]);

const V2_EVENT_TYPES = new Set([
  'models-dev.refreshed',
  'agent.updated',
  'session.agent.selected',
  'session.model.selected',
  'session.moved',
  'session.renamed',
  'session.forked',
  'session.inbox.delivered',
  'session.inbox.enqueued',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.instructions.updated',
  'session.synthetic',
  'session.skill.activated',
  'session.shell.started',
  'session.shell.ended',
  'session.step.started',
  'session.step.ended',
  'session.step.failed',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.retry.scheduled',
  'session.compaction.started',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'session.usage.updated',
  'filesystem.changed',
  'worktree.updated',
  'worktree.resolved',
  'plugin.added',
  'plugin.updated',
  'form.created',
  'form.replied',
  'form.cancelled',
]);

const V2_PASSTHROUGH_TYPES = new Set([
  'models-dev.refreshed',
  'agent.updated',
  'mcp.status.changed',
  'mcp.resources.changed',
  'mcp.tools.changed',
  'mcp.browser.open.failed',
  'command.executed',
  'config.updated',
  'skill.updated',
  'file.edited',
  'shell.created',
  'shell.exited',
  'shell.deleted',
  'websearch.updated',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'tui.session.select',
]);

const isCurrentV2Type = (type) => type.startsWith('session.next.')
  || type.startsWith('permission.v2.')
  || type.startsWith('question.v2.')
  || V2_EVENT_TYPES.has(type);

const isLegacyPayload = (type, properties) => {
  if (type === 'session.created' || type === 'session.updated' || type === 'session.deleted') {
    return isObject(properties.info);
  }
  if (type === 'permission.asked') {
    return 'permission' in properties || 'patterns' in properties;
  }
  if (type === 'question.asked') {
    return Array.isArray(properties.questions);
  }
  return LEGACY_EVENT_TYPES.has(type) || V2_PASSTHROUGH_TYPES.has(type) || !isCurrentV2Type(type);
};

const isKnownLegacyType = (type) => LEGACY_EVENT_TYPES.has(type);
const isPassthroughType = (type) => LEGACY_EVENT_TYPES.has(type) || V2_PASSTHROUGH_TYPES.has(type);

export function createOpenCode2EventNormalizer() {
  const sessions = new Map();
  const tools = new Map();
  const assistants = new Map();
  const forms = new Map();

  const normalize = ({ envelope, payload }) => {
    const value = isObject(payload?.payload) ? payload.payload : payload;
    if (!isObject(value) || !isString(value.type)) return null;
    if (value.type === 'sync') return null;

    const data = eventData(value);
    const type = value.type;
    const directory = eventDirectory(envelope, value, data);
    const eventId = isString(envelope?.eventId) && envelope.eventId.length > 0 ? envelope.eventId : undefined;
    const jsonID = isString(value.id) && value.id.length > 0 ? value.id : undefined;
    const created = numberValue(value.created) ?? numberValue(data?.timestamp) ?? numberValue(data?.time?.created) ?? 0;

    if (!data) {
      if (!isCurrentV2Type(type) && isKnownLegacyType(type)) {
        const legacyPayload = { ...value };
        assignWhen(legacyPayload, 'id', jsonID, Boolean(jsonID));
        return { envelope, payload: legacyPayload, directory, eventId };
      }
      return null;
    }

    if (!value.data && value.properties && isLegacyPayload(type, value.properties)) {
      const legacyPayload = { ...value, properties: addDirectory(value.properties, directory) };
      if (type === 'session.created' || type === 'session.updated') {
        const info = legacyPayload.properties?.info;
        if (isObject(info) && isString(info.id)) sessions.set(info.id, info);
      }
      return { envelope, payload: legacyPayload, directory, eventId };
    }

    let normalizedPayload;
    const withDirectory = (properties) => addDirectory(properties, directory);
    const sessionID = data.sessionID;
    const normalizedType = type.replace(/\.\d+$/, '');

    switch (normalizedType) {
      case 'session.created': {
        if (!isString(sessionID)) break;
        const info = sessionInfoFromCreatedEvent(data, directory, created);
        sessions.set(sessionID, info);
        normalizedPayload = { type: 'session.created', properties: withDirectory({ sessionID, info }) };
        break;
      }
      case 'session.renamed':
      case 'session.agent.selected':
      case 'session.next.agent.switched':
      case 'session.model.selected':
      case 'session.next.model.switched':
      case 'session.moved':
      case 'session.next.moved': {
        const updateType = normalizedType.includes('agent') ? 'session.agent.selected'
          : normalizedType.includes('model') ? 'session.model.selected'
            : normalizedType.includes('moved') ? 'session.moved' : 'session.renamed';
        const updateData = { ...data };
        if (isString(updateData.subdirectory) && updateData.subpath === undefined) updateData.subpath = updateData.subdirectory;
        const info = sessionInfoFromUpdateEvent(updateData, directory, updateType, created, sessions);
        if (info) normalizedPayload = { type: 'session.updated', properties: withDirectory({ sessionID: info.id, info }) };
        break;
      }
      case 'session.deleted':
        if (isString(sessionID)) {
          const info = sessions.get(sessionID) ?? fallbackSession(sessionID, directory, created);
          normalizedPayload = { type: 'session.deleted', properties: withDirectory({ sessionID, info }) };
          sessions.delete(sessionID);
        }
        break;
      case 'session.status':
        if (isString(sessionID)) normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: data.status }) };
        break;
      case 'session.idle':
      case 'session.execution.succeeded':
        if (isString(sessionID)) normalizedPayload = { type: 'session.idle', properties: withDirectory({ sessionID }) };
        break;
      case 'session.execution.started':
        if (isString(sessionID)) normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: { type: 'busy' } }) };
        break;
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        if (isString(sessionID)) {
          const message = normalizedType === 'session.execution.failed' ? errorMessage(data.error) : data.reason;
          normalizedPayload = {
            type: 'session.error',
            properties: withDirectory({ sessionID, error: { name: normalizedType.endsWith('failed') ? 'UnknownError' : 'MessageAbortedError', data: { message: isString(message) ? message : '' } } }),
          };
        }
        break;
      case 'session.next.step.started':
      case 'session.step.started': {
        if (!isString(sessionID) || !isString(data.assistantMessageID)) break;
        const info = assistantInfo(data, directory, created);
        assistants.set(info.id, info);
        normalizedPayload = { type: 'message.updated', properties: withDirectory({ sessionID, info }) };
        break;
      }
      case 'session.next.step.ended':
      case 'session.step.ended':
        if (isString(sessionID) && isString(data.assistantMessageID)) normalizedPayload = { type: 'message.updated', properties: withDirectory({ sessionID, info: finishAssistant(data, directory, created, assistants, false) }) };
        break;
      case 'session.next.step.failed':
      case 'session.step.failed':
        if (isString(sessionID) && isString(data.assistantMessageID)) normalizedPayload = { type: 'message.updated', properties: withDirectory({ sessionID, info: finishAssistant(data, directory, created, assistants, true) }) };
        break;
      case 'session.next.text.started':
      case 'session.text.started':
        if (isString(sessionID)) normalizedPayload = { type: 'message.part.updated', properties: withDirectory({ sessionID, part: { id: partID(data, 'text'), sessionID, messageID: data.assistantMessageID, type: 'text', text: '', time: { start: created } }, time: created }) };
        break;
      case 'session.next.text.delta':
      case 'session.text.delta':
        if (isString(sessionID)) normalizedPayload = { type: 'message.part.delta', properties: withDirectory({ sessionID, messageID: data.assistantMessageID, partID: partID(data, 'text'), field: 'text', delta: data.delta }) };
        break;
      case 'session.next.text.ended':
      case 'session.text.ended':
        if (isString(sessionID)) normalizedPayload = { type: 'message.part.updated', properties: withDirectory({ sessionID, part: { id: partID(data, 'text'), sessionID, messageID: data.assistantMessageID, type: 'text', text: data.text, time: { start: created, end: created } }, time: created }) };
        break;
      case 'session.next.reasoning.started':
      case 'session.reasoning.started':
        if (isString(sessionID)) normalizedPayload = { type: 'message.part.updated', properties: withDirectory({ sessionID, part: { id: partID(data, 'reasoning'), sessionID, messageID: data.assistantMessageID, type: 'reasoning', text: '', time: { start: created } }, time: created }) };
        break;
      case 'session.next.reasoning.delta':
      case 'session.reasoning.delta':
        if (isString(sessionID)) normalizedPayload = { type: 'message.part.delta', properties: withDirectory({ sessionID, messageID: data.assistantMessageID, partID: partID(data, 'reasoning'), field: 'text', delta: data.delta }) };
        break;
      case 'session.next.reasoning.ended':
      case 'session.reasoning.ended':
        if (isString(sessionID)) normalizedPayload = { type: 'message.part.updated', properties: withDirectory({ sessionID, part: { id: partID(data, 'reasoning'), sessionID, messageID: data.assistantMessageID, type: 'reasoning', text: data.text, time: { start: created, end: created } }, time: created }) };
        break;
      case 'session.next.tool.input.started':
      case 'session.tool.input.started': {
        const id = toolID(data);
        if (!isString(id)) break;
        tools.set(id, { sessionID, messageID: data.assistantMessageID, name: data.name ?? data.tool ?? '', input: {}, started: created, raw: '' });
        normalizedPayload = partEvent(jsonID, data, { status: 'pending', input: {}, raw: '' }, created, tools);
        break;
      }
      case 'session.next.tool.input.delta':
      case 'session.tool.input.delta': {
        const id = toolID(data);
        const snapshot = isString(id) ? tools.get(id) : undefined;
        if (snapshot && isString(data.delta)) snapshot.raw += data.delta;
        normalizedPayload = partEvent(jsonID, data, { status: 'pending', input: snapshot?.input ?? {}, raw: snapshot?.raw ?? data.delta ?? '' }, created, tools);
        break;
      }
      case 'session.next.tool.input.ended':
      case 'session.tool.input.ended': {
        const id = toolID(data);
        const snapshot = isString(id) ? tools.get(id) : undefined;
        let input = snapshot?.input ?? {};
        try {
          const parsed = JSON.parse(data.text);
          if (isObject(parsed)) input = parsed;
        } catch {
          // The tool.called event is authoritative when JSON parsing fails.
        }
        if (snapshot) snapshot.input = input;
        normalizedPayload = partEvent(jsonID, data, { status: 'running', input, time: { start: snapshot?.started ?? created } }, created, tools);
        break;
      }
      case 'session.next.tool.called':
      case 'session.tool.called': {
        const id = toolID(data);
        if (!isString(id)) break;
        const snapshot = { sessionID, messageID: data.assistantMessageID, name: data.tool ?? tools.get(id)?.name ?? '', input: data.input ?? {}, started: tools.get(id)?.started ?? created, raw: tools.get(id)?.raw ?? '' };
        tools.set(id, snapshot);
        normalizedPayload = partEvent(jsonID, data, { status: 'running', input: snapshot.input, time: { start: snapshot.started } }, created, tools);
        break;
      }
      case 'session.next.tool.progress':
      case 'session.tool.progress': {
        const id = toolID(data);
        const snapshot = isString(id) ? tools.get(id) : undefined;
        if (snapshot && isObject(data.metadata)) snapshot.metadata = data.metadata;
        normalizedPayload = partEvent(jsonID, data, { status: 'running', input: snapshot?.input ?? {}, metadata: data.metadata ?? data.structured, time: { start: snapshot?.started ?? created } }, created, tools);
        break;
      }
      case 'session.next.tool.success':
      case 'session.tool.success': {
        const id = toolID(data);
        if (!isString(id)) break;
        const snapshot = tools.get(id);
        const state = {
          status: 'completed',
          input: snapshot?.input ?? data.input ?? {},
          output: toolOutput(data.content),
          title: snapshot?.name ?? data.tool ?? '',
          metadata: data.metadata ?? data.structured ?? {},
          time: { start: snapshot?.started ?? created, end: created },
        };
        const attachments = toolAttachments(data.sessionID, data.assistantMessageID, id, data.content);
        if (attachments) state.attachments = attachments;
        normalizedPayload = partEvent(jsonID, data, state, created, tools);
        tools.delete(id);
        break;
      }
      case 'session.next.tool.failed':
      case 'session.tool.failed': {
        const id = toolID(data);
        if (!isString(id)) break;
        const snapshot = tools.get(id);
        const state = {
          status: 'error',
          input: snapshot?.input ?? data.input ?? {},
          error: errorMessage(data.error),
          time: { start: snapshot?.started ?? created, end: created },
        };
        assignWhen(state, 'metadata', data.metadata, isObject(data.metadata));
        normalizedPayload = partEvent(jsonID, data, state, created, tools);
        tools.delete(id);
        break;
      }
      case 'session.next.retried':
        if (isString(sessionID)) normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: { type: 'retry', attempt: data.attempt, message: errorMessage(data.error), next: 0 } }) };
        break;
      case 'session.retry.scheduled':
        if (isString(sessionID)) normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: { type: 'retry', attempt: data.attempt, message: errorMessage(data.error), next: numberValue(data.at) ?? 0 } }) };
        break;
      case 'session.next.compaction.started':
      case 'session.compaction.started':
        if (isString(sessionID)) normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: { type: 'busy' } }) };
        break;
      case 'session.next.compaction.ended':
      case 'session.compaction.ended':
        if (isString(sessionID)) normalizedPayload = { type: 'session.compacted', properties: withDirectory({ sessionID }) };
        break;
      case 'session.next.compaction.failed':
      case 'session.compaction.failed':
        if (isString(sessionID)) normalizedPayload = { type: 'session.error', properties: withDirectory({ sessionID, error: normalizeError(data.error) }) };
        break;
      case 'session.next.revert.staged':
      case 'session.next.revert.cleared':
      case 'session.next.revert.committed':
      case 'session.revert.staged':
      case 'session.revert.cleared':
      case 'session.revert.committed': {
        const info = isString(sessionID) ? sessionInfoFromUpdateEvent(data, directory, 'session.moved', created, sessions) : null;
        if (info) normalizedPayload = { type: 'session.updated', properties: withDirectory({ sessionID: info.id, info }) };
        break;
      }
      case 'permission.v2.asked':
      case 'permission.asked':
        if (isString(sessionID) && isString(data.id)) normalizedPayload = { type: 'permission.asked', properties: withDirectory(normalizePermission(data)) };
        break;
      case 'permission.v2.replied':
      case 'permission.replied':
        if (isString(sessionID)) normalizedPayload = { type: 'permission.replied', properties: withDirectory({ sessionID, requestID: data.requestID, reply: data.reply }) };
        break;
      case 'question.v2.asked':
      case 'question.asked':
        if (isString(sessionID) && isString(data.id)) {
          const properties = { id: data.id, sessionID, questions: data.questions };
          assignWhen(properties, 'tool', data.tool, Boolean(data.tool));
          normalizedPayload = { type: 'question.asked', properties: withDirectory(properties) };
        }
        break;
      case 'question.v2.replied':
      case 'question.replied':
        if (isString(sessionID)) normalizedPayload = { type: 'question.replied', properties: withDirectory({ sessionID, requestID: data.requestID, answers: data.answers ?? [] }) };
        break;
      case 'question.v2.rejected':
      case 'question.rejected':
        if (isString(sessionID)) normalizedPayload = { type: 'question.rejected', properties: withDirectory({ sessionID, requestID: data.requestID }) };
        break;
      case 'form.created': {
        const form = isObject(data.form) ? data.form : null;
        if (form && isString(form.id) && isString(form.sessionID)) {
          forms.set(form.id, form);
          normalizedPayload = { type: 'question.asked', properties: withDirectory(normalizeQuestion(form)) };
        }
        break;
      }
      case 'form.replied': {
        const form = forms.get(data.id);
        if (!form) break;
        forms.delete(data.id);
        normalizedPayload = {
          type: 'question.replied',
          properties: withDirectory({
            sessionID: data.sessionID,
            requestID: data.id,
            answers: Array.isArray(form.fields) ? form.fields.map((field) => {
              const value = data.answer?.[field.key];
              return Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)];
            }) : [],
          }),
        };
        break;
      }
      case 'form.cancelled':
        forms.delete(data.id);
        if (isString(sessionID)) normalizedPayload = { type: 'question.rejected', properties: withDirectory({ sessionID, requestID: data.id }) };
        break;
      case 'filesystem.changed':
        normalizedPayload = { type: 'file.watcher.updated', properties: withDirectory(data) };
        break;
      case 'worktree.updated':
      case 'worktree.resolved':
        normalizedPayload = { type: 'project.directories.updated', properties: withDirectory(data) };
        break;
      case 'vcs.branch.updated':
        normalizedPayload = { type: 'vcs.branch.updated', properties: withDirectory({ branch: data.branch ?? '' }) };
        break;
      default:
        if (isPassthroughType(normalizedType)) normalizedPayload = { type: normalizedType, properties: withDirectory(data) };
        break;
    }

    if (!normalizedPayload) {
      if (!isCurrentV2Type(type) && !value.data) return null;
      const fallbackPayload = { type, data };
      assignWhen(fallbackPayload, 'id', jsonID, Boolean(jsonID));
      assignWhen(fallbackPayload, 'location', { directory }, directory !== 'global');
      return {
        envelope: { eventId, directory, payload: fallbackPayload },
        payload: fallbackPayload,
        directory,
        eventId,
      };
    }
    if (jsonID) normalizedPayload = { ...normalizedPayload, id: jsonID };
    return {
      envelope: { eventId, directory, payload: normalizedPayload },
      payload: normalizedPayload,
      directory,
      eventId,
    };
  };

  return {
    normalize,
    reset() {
      sessions.clear();
      tools.clear();
      assistants.clear();
      forms.clear();
    },
  };
}
