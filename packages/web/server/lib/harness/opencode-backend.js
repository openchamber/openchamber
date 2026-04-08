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
    const response = await client.session.create({
      ...(title ? { title } : {}),
      ...(parentID ? { parentID } : {}),
    }, {
      throwOnError: true,
    });

    if (!response.data) {
      throw new Error('OpenCode session create returned no data');
    }

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

    const client = createClient(directory);
    const response = await client.session.promptAsync({
      sessionID,
      ...(input?.messageID ? { messageID: input.messageID } : {}),
      ...(input?.model ? { model: input.model } : {}),
      ...(input?.agent ? { agent: input.agent } : {}),
      ...(input?.variant ? { variant: input.variant } : {}),
      ...(input?.format ? { format: input.format } : {}),
      ...(Array.isArray(input?.parts) ? { parts: input.parts } : {}),
    }, {
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
    const [agentsResponse, providersResponse] = await Promise.all([
      client.app.agents(directory ? { directory } : undefined, { throwOnError: true }),
      client.config.providers(directory ? { directory } : undefined, { throwOnError: true }),
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

    return {
      backendId: 'opencode',
      modeSelector: {
        kind: 'agent',
        label: 'Agent',
        items: visibleAgents,
      },
      modelSelector: {
        label: 'Model',
        source: 'providers',
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
    };
  };

  return {
    createSession,
    promptAsync,
    command,
    abortSession,
    updateSession,
    getControlSurface,
  };
};
