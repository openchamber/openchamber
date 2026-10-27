import { createOpencodeClient } from '@opencode-ai/sdk/v2';

export const createOpenCodeBackendRuntime = (dependencies) => {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = dependencies;

  const createClient = (directory) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const trimmedDirectory = typeof directory === 'string' && directory.trim().length > 0
      ? directory.trim()
      : undefined;

    return createOpencodeClient({
      baseUrl,
      headers: getOpenCodeAuthHeaders(),
      ...(trimmedDirectory ? { directory: trimmedDirectory } : {}),
    });
  };

  const createSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' ? input.directory.trim() : '';
    const title = typeof input?.title === 'string' ? input.title : undefined;
    const parentID = typeof input?.parentID === 'string' ? input.parentID : undefined;

    const client = createClient(directory);
    const body = {
      ...(title ? { title } : {}),
      ...(parentID ? { parentID } : {}),
      ...(typeof input?.agent === 'string' && input.agent ? { agent: input.agent } : {}),
    };
    // OpenCode v2 rejects an empty POST body ("Expected object"); the SDK omits the body entirely
    // when every mapped field is absent. Seed a harmless body key so the request always has one.
    if (Object.keys(body).length === 0) {
      body.metadata = {};
    }
    const response = await client.session.create(body, {
      throwOnError: true,
    });

    if (!response.data) {
      throw new Error('OpenCode session create returned no data');
    }

    // v2 wraps payloads as { data: … }; earlier shapes returned the session directly.
    return response.data?.data ?? response.data;
  };

  const listSessions = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const client = createClient(directory);
    const response = await client.session.list(directory ? { directory } : undefined, {
      throwOnError: true,
    });
    return Array.isArray(response.data) ? response.data : [];
  };

  const getSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.get({
      sessionID,
      ...(directory ? { directory } : {}),
    }, {
      throwOnError: true,
    });
    return response.data ?? null;
  };

  // v2 returns flat messages ({ type, text } for user, { type, content:[…] } for assistant).
  // OpenChamber's shared routes expect the v1 record shape ({ info, parts }), so normalise here.
  const normalizeV2Message = (record, sessionID) => {
    if (!record || typeof record !== 'object') return record;
    if (record.info && Array.isArray(record.parts)) return record; // already v1-shaped
    if (record.type === 'model-switched') return null; // pure event, no renderable content
    if (record.type === 'idle' && !record.error) return null; // successful idle marker

    const role = record.type === 'assistant' ? 'assistant' : record.type === 'user' ? 'user' : 'system';
    const info = {
      id: typeof record.id === 'string' ? record.id : `${sessionID}-${Math.random().toString(36).slice(2)}`,
      sessionId: record.sessionID || sessionID,
      role,
      time: record.time && typeof record.time === 'object' ? record.time : { created: 0 },
      ...(typeof record.finish === 'string' ? { finish: record.finish } : {}),
      ...(record.attribution && typeof record.attribution === 'object' ? { attribution: record.attribution } : {}),
    };

    const parts = [];
    const pushPart = (part) => {
      if (!part || typeof part !== 'object') return;
      const base = { id: part.id, sessionId: info.sessionId, messageId: info.id };
      if (part.type === 'reasoning') {
        parts.push({ ...base, type: 'reasoning', text: typeof part.text === 'string' ? part.text : '' });
        return;
      }
      if (part.type === 'tool') {
        parts.push({
          ...base,
          type: 'tool',
          callID: part.id,
          tool: part.name || 'tool',
          state: part.state,
        });
        return;
      }
      if (part.type === 'text') {
        parts.push({ ...base, type: 'text', text: typeof part.text === 'string' ? part.text : '' });
      }
    };

    if (Array.isArray(record.content)) {
      record.content.forEach(pushPart);
    } else if (typeof record.text === 'string') {
      parts.push({ id: `${info.id}-0`, sessionId: info.sessionId, messageId: info.id, type: 'text', text: record.text });
    }

    const error = record.error;
    if (error && parts.length === 0) {
      const text = typeof error === 'string' ? error : error?.message || JSON.stringify(error);
      parts.push({ id: `${info.id}-err`, sessionId: info.sessionId, messageId: info.id, type: 'text', text });
    }

    return { info, parts };
  };

  // Only fall back when the request provably never reached the server; a reset/read timeout
  // after the POST was accepted must NOT be retried (it would duplicate the turn).
  const isUnsentFetchError = (error) => {
    const code = error?.cause?.code || error?.code;
    return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
  };

  // v2 lists messages at GET /session/{id}/message (singular) and wraps the array as { data }.
  const getMessagesRaw = async (sessionID, params = {}) => {
    const qs = new URLSearchParams();
    if (params.directory) qs.set('directory', params.directory);
    if (typeof params.limit === 'number') qs.set('limit', String(params.limit));
    if (typeof params.before === 'string' && params.before) qs.set('before', params.before);
    const query = qs.toString();
    let res;
    try {
      res = await fetch(
        buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/message`, '') + (query ? `?${query}` : ''),
        { headers: { accept: 'application/json', ...getOpenCodeAuthHeaders() } },
      );
    } catch (error) {
      if (isUnsentFetchError(error)) return null; // never reached upstream -> SDK fallback
      throw error;
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`opencode messages failed (${res.status}): ${JSON.stringify(json)?.slice(0, 200)}`);
    }
    const data = json?.data ?? json;
    return Array.isArray(data)
      ? data.map((record) => normalizeV2Message(record, sessionID)).filter(Boolean)
      : [];
  };

  const getMessages = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const raw = await getMessagesRaw(sessionID, {
      directory,
      limit: input?.limit,
      before: input?.before,
    });
    if (raw !== null) {
      return raw;
    }

    const client = createClient(directory);
    const response = await client.session.messages({
      sessionID,
      ...(directory ? { directory } : {}),
      ...(typeof input?.limit === 'number' ? { limit: input.limit } : {}),
      ...(typeof input?.before === 'string' ? { before: input.before } : {}),
    }, {
      throwOnError: true,
    });
    return Array.isArray(response.data) ? response.data : [];
  };

  // OpenCode v2 moved prompt to POST /session/{id}/prompt and requires a top-level `text`.
  // The bundled SDK still posts to the removed /session/{id}/message, so send prompt raw and
  // fall back to the SDK only if the raw route is missing (older servers).
  const buildPromptBody = (input = {}) => {
    const body = {
      ...(typeof input?.messageID === 'string' ? { messageID: input.messageID } : {}),
      ...(input?.model ? { model: input.model } : {}),
      ...(input?.agent ? { agent: input.agent } : {}),
      ...(input?.variant ? { variant: input.variant } : {}),
      ...(input?.format ? { format: input.format } : {}),
      ...(Array.isArray(input?.parts) ? { parts: input.parts } : {}),
    };
    if (typeof input?.text === 'string') {
      body.text = input.text;
    } else if (Array.isArray(body.parts)) {
      const text = body.parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      if (text) body.text = text;
    }
    return body;
  };

  // v2 ignores `model` in the prompt body; it is switched on the session instead
  // (POST /session/{id}/model). Map the caller's { providerID, modelID } to v2's { id, providerID }.
  const switchModelRaw = async (sessionID, model) => {
    if (!model || typeof model !== 'object') return;
    const id = model.modelID || model.id;
    const providerID = model.providerID || model.provider;
    if (!id || !providerID) return;
    try {
      await fetch(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/model`, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...getOpenCodeAuthHeaders() },
        body: JSON.stringify({ model: { id, providerID } }),
      });
    } catch {
      // best effort; prompting still works with the session default model
    }
  };

  const postPromptRaw = async (sessionID, body) => {
    let res;
    try {
      res = await fetch(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/prompt`, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...getOpenCodeAuthHeaders() },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (isUnsentFetchError(error)) return null; // never reached upstream -> SDK fallback
      throw error; // may have been accepted; do not risk a duplicate turn
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) return null;
    if (res.status === 204) return {}; // accepted, no body
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON success body */ }
    if (!res.ok) {
      throw new Error(`opencode prompt failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return json?.data ?? json ?? {};
  };

  const prompt = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const body = buildPromptBody(input);
    await switchModelRaw(sessionID, input?.model);
    const raw = await postPromptRaw(sessionID, body);
    if (raw !== null) {
      return raw;
    }

    const client = createClient(directory);
    const response = await client.session.prompt({ sessionID, ...body }, {
      throwOnError: true,
    });

    return response.data;
  };

  const promptAsync = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const body = buildPromptBody(input);
    await switchModelRaw(sessionID, input?.model);
    const raw = await postPromptRaw(sessionID, body);
    if (raw !== null) {
      return raw;
    }

    const client = createClient(directory);
    const response = await client.session.promptAsync({ sessionID, ...body }, {
      throwOnError: true,
    });

    return response.data;
  };

  const command = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.command({
      sessionID,
      ...(input?.messageID ? { messageID: input.messageID } : {}),
      ...(input?.agent ? { agent: input.agent } : {}),
      ...(input?.model ? { model: input.model } : {}),
      command: input.command,
      arguments: input.arguments ?? '',
      ...(input?.variant ? { variant: input.variant } : {}),
      ...(Array.isArray(input?.parts) ? { parts: input.parts } : {}),
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const abortSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.abort({
      sessionID,
    }, {
      throwOnError: true,
    });
    return response.data;
  };

  const updateSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.update({
      sessionID,
      ...(typeof input?.title === 'string' ? { title: input.title } : {}),
      ...(input?.time ? { time: input.time } : {}),
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const deleteSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.delete({
      sessionID,
      ...(directory ? { directory } : {}),
    }, {
      throwOnError: true,
    });
    return response.data ?? true;
  };

  const forkSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.fork({
      sessionID,
      ...(typeof input?.messageID === 'string' && input.messageID.trim().length > 0
        ? { messageID: input.messageID.trim() }
        : {}),
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const shareSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.share({
      sessionID,
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const unshareSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.unshare({
      sessionID,
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const revertSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    const messageID = typeof input?.messageID === 'string' ? input.messageID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }
    if (!messageID) {
      throw new Error('Message ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.revert({
      sessionID,
      messageID,
      ...(typeof input?.partID === 'string' && input.partID.trim().length > 0 ? { partID: input.partID.trim() } : {}),
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const unrevertSession = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    if (!sessionID) {
      throw new Error('Session ID is required');
    }

    const client = createClient(directory);
    const response = await client.session.unrevert({
      sessionID,
    }, {
      throwOnError: true,
    });

    return response.data;
  };

  const replyToPermission = async (requestId, reply, input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const client = createClient(directory);
    const response = await client.permission.reply({
      requestID: requestId,
      reply,
      ...(directory ? { directory } : {}),
    }, {
      throwOnError: true,
    });
    return response.data;
  };

  const replyToQuestion = async (requestId, answers, input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const client = createClient(directory);
    const response = await client.question.reply({
      requestID: requestId,
      answers,
      ...(directory ? { directory } : {}),
    }, {
      throwOnError: true,
    });
    return response.data;
  };

  const rejectQuestion = async (requestId, input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const client = createClient(directory);
    const response = await client.question.reject({
      requestID: requestId,
      ...(directory ? { directory } : {}),
    }, {
      throwOnError: true,
    });
    return response.data;
  };

  const getControlSurface = async (input = {}) => {
    const directory = typeof input?.directory === 'string' && input.directory.trim().length > 0
      ? input.directory.trim()
      : undefined;
    const providerId = typeof input?.providerId === 'string' && input.providerId.trim().length > 0
      ? input.providerId.trim()
      : undefined;
    const modelId = typeof input?.modelId === 'string' && input.modelId.trim().length > 0
      ? input.modelId.trim()
      : undefined;

    const client = createClient(directory);
    const [agentsResponse, providersResponse, commandsResponse] = await Promise.all([
      client.app.agents(directory ? { directory } : undefined, { throwOnError: true }),
      client.config.providers(directory ? { directory } : undefined, { throwOnError: true }),
      client.command.list(directory ? { directory } : undefined, { throwOnError: true }),
    ]);

    const rawAgents = Array.isArray(agentsResponse.data) ? agentsResponse.data : [];
    const visibleAgents = rawAgents
      .filter((agent) => agent && agent.mode !== 'subagent')
      .filter((agent) => agent.hidden !== true && agent.options?.hidden !== true)
      .map((agent) => ({
        id: agent.name,
        label: typeof agent.name === 'string' && agent.name.length > 0
          ? agent.name.charAt(0).toUpperCase() + agent.name.slice(1)
          : 'Unknown',
        ...(typeof agent.description === 'string' && agent.description.trim().length > 0
          ? { description: agent.description.trim() }
          : {}),
        ...(typeof agent.color === 'string' && agent.color.trim().length > 0
          ? { color: agent.color.trim() }
          : {}),
      }));

    const providersPayload = providersResponse.data && typeof providersResponse.data === 'object'
      ? providersResponse.data
      : {};
    const providerMap = providersPayload.providers && typeof providersPayload.providers === 'object'
      ? providersPayload.providers
      : {};

    const resolvedProviderId = providerId
      || (typeof providersPayload.default?.chat === 'string' ? providersPayload.default.chat : undefined)
      || Object.keys(providerMap)[0];
    const provider = resolvedProviderId && providerMap[resolvedProviderId]
      ? providerMap[resolvedProviderId]
      : null;
    const providerModels = provider?.models && typeof provider.models === 'object'
      ? provider.models
      : {};
    const resolvedModelId = modelId || Object.keys(providerModels)[0];
    const model = resolvedModelId && providerModels[resolvedModelId]
      ? providerModels[resolvedModelId]
      : null;
    const variants = model?.variants && typeof model.variants === 'object'
      ? Object.keys(model.variants)
      : [];
    const rawCommands = Array.isArray(commandsResponse.data) ? commandsResponse.data : [];

    const modelOptions = Object.entries(providerMap).flatMap(([snapshotProviderId, snapshotProvider]) => {
      const snapshotModels = snapshotProvider?.models && typeof snapshotProvider.models === 'object'
        ? snapshotProvider.models
        : {};
      return Object.entries(snapshotModels).map(([id, modelEntry]) => {
      const label = typeof modelEntry?.name === 'string' && modelEntry.name.trim().length > 0
        ? modelEntry.name.trim()
        : id;
      const modelVariants = modelEntry?.variants && typeof modelEntry.variants === 'object'
        ? Object.keys(modelEntry.variants)
        : [];
      return {
        id,
        label,
        ...(modelVariants.length > 0
          ? {
              optionDescriptors: [{
                id: 'variant',
                label: 'Thinking',
                type: 'select',
                options: modelVariants.map((variant) => ({
                  id: variant,
                  label: variant.charAt(0).toUpperCase() + variant.slice(1),
                })),
              }],
            }
          : {}),
        raw: modelEntry,
        providerId: snapshotProviderId,
      };
      });
    });

    return {
      backendId: 'opencode',
      providerSnapshot: {
        backendId: 'opencode',
        label: 'OpenCode',
        enabled: true,
        auth: { status: 'unknown' },
        capabilities: {
          chat: true,
          sessions: true,
          models: true,
          commands: true,
          providers: true,
          auth: true,
          config: true,
          skills: true,
          shell: true,
        },
        models: modelOptions,
        interactionModes: visibleAgents.map((agent) => ({
          id: agent.id,
          label: agent.label,
          ...(agent.description ? { description: agent.description } : {}),
        })),
        commands: rawCommands
          .filter((command) => command && typeof command.name === 'string' && command.name.trim().length > 0)
          .map((command) => ({
            id: command.name.trim(),
            label: command.name.trim(),
            ...(typeof command.description === 'string' && command.description.trim().length > 0
              ? { description: command.description.trim() }
              : {}),
            raw: command,
          })),
        raw: providersPayload,
      },
      modeSelector: {
        kind: 'agent',
        label: 'Agent',
        items: visibleAgents,
      },
      modelSelector: {
        label: 'Model',
        source: 'provider-snapshot',
      },
      effortSelector: {
        label: 'Thinking',
        source: 'model-variants',
        defaultOptionId: null,
        options: variants.map((variant) => ({
          id: variant,
          label: variant.charAt(0).toUpperCase() + variant.slice(1),
        })),
      },
      commandSelector: {
        source: 'config',
        items: rawCommands
          .filter((command) => command && typeof command.name === 'string' && command.name.trim().length > 0)
          .map((command) => ({
            name: command.name.trim(),
            ...(typeof command.description === 'string' && command.description.trim().length > 0
              ? { description: command.description.trim() }
              : {}),
            ...(typeof command.agent === 'string' && command.agent.trim().length > 0
              ? { agent: command.agent.trim() }
              : {}),
            ...(typeof command.model === 'string' && command.model.trim().length > 0
              ? { model: command.model.trim() }
              : {}),
            ...(typeof command.template === 'string' && command.template.trim().length > 0
              ? { template: command.template }
              : {}),
            executionMode: 'session-command',
          })),
      },
    };
  };

  return {
    listSessions,
    createSession,
    getSession,
    getMessages,
    prompt,
    promptAsync,
    command,
    abortSession,
    updateSession,
    deleteSession,
    forkSession,
    shareSession,
    unshareSession,
    revertSession,
    unrevertSession,
    replyToPermission,
    replyToQuestion,
    rejectQuestion,
    getControlSurface,
  };
};
