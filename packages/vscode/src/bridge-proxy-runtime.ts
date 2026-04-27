import type { BridgeContext, BridgeResponse } from './bridge';
import { waitForApiUrl } from './opencode-ready';
// @ts-expect-error Cross-package JS module has no local d.ts in vscode package.
import * as sharedBackendsModule from '../../web/server/lib/harness/backends.js';

type BackendDescriptor = {
  id: string;
  label: string;
  available: boolean;
  comingSoon?: boolean;
  capabilities: {
    chat: boolean;
    sessions: boolean;
    models: boolean;
    agents: boolean;
    providers: boolean;
    commands: boolean;
    config: boolean;
    skills: boolean;
    auth?: boolean;
  };
};

// Single source of truth from web backend registry module.
const sharedBackends = sharedBackendsModule as {
  BACKEND_DESCRIPTORS: readonly BackendDescriptor[];
  DEFAULT_BACKEND_ID: string;
};

const { BACKEND_DESCRIPTORS, DEFAULT_BACKEND_ID } = sharedBackends;

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ApiProxyRequestPayload = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

type ApiSessionMessageRequestPayload = {
  path?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

type ProxyRuntimeDeps = {
  tryHandleLocalFsProxy: (method: string, requestPath: string) => Promise<ApiProxyResponsePayload | null>;
  buildUnavailableApiResponse: () => ApiProxyResponsePayload;
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => Record<string, string>;
  collectHeaders: (headers: Headers) => Record<string, string>;
  base64EncodeUtf8: (text: string) => string;
  readSettings: (ctx: BridgeContext | undefined) => Record<string, unknown>;
};

type ForwardRequestInput = {
  apiUrl: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  deps: ProxyRuntimeDeps;
  annotateBackend?: boolean;
};

type HarnessForwardInput = Omit<ForwardRequestInput, 'deps'>;

type JsonRecord = Record<string, unknown>;

class HarnessRuntimeManager {
  constructor(private readonly deps: ProxyRuntimeDeps) {}

  async handle(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    bodyBase64?: string;
    apiUrl: string;
  }): Promise<ApiProxyResponsePayload | null> {
    const parsed = new URL(input.path, 'https://openchamber.invalid');
    if (!parsed.pathname.startsWith('/openchamber/harness')) {
      return null;
    }

    const harnessPath = parsed.pathname.slice('/openchamber/harness'.length) || '/';
    const body = decodeJsonBody(input.bodyBase64);
    const requestedBackendId = getRequestedBackendId(parsed, body);
    if (requestedBackendId !== 'opencode') {
      return this.json(400, { error: `Unsupported backend: ${requestedBackendId}` });
    }

    if (input.method === 'GET' && harnessPath === '/control-surface') {
      return this.getControlSurface(input.apiUrl, input.headers, parsed);
    }

    if (input.method === 'GET' && harnessPath === '/sessions') {
      const upstreamPath = withSearch('/session', parsed.searchParams);
      return this.forward({ ...input, path: upstreamPath, annotateBackend: true });
    }

    if (input.method === 'POST' && harnessPath === '/session') {
      return this.forward({ ...input, path: '/session', annotateBackend: true });
    }

    const sessionMatch = harnessPath.match(/^\/session\/([^/]+)(?:\/(messages|message|prompt|command|abort|update|fork))?$/);
    if (!sessionMatch) {
      return this.json(404, { error: 'Harness route not found' });
    }

    const sessionId = sessionMatch[1];
    const action = sessionMatch[2] || '';
    const encodedSessionId = encodeURIComponent(sessionId);

    if (input.method === 'GET' && !action) {
      return this.forward({ ...input, path: withSearch(`/session/${encodedSessionId}`, parsed.searchParams), annotateBackend: true });
    }
    if (input.method === 'GET' && action === 'messages') {
      return this.forward({ ...input, path: withSearch(`/session/${encodedSessionId}/message`, parsed.searchParams) });
    }
    if (input.method === 'POST' && action === 'message') {
      return this.forward({ ...input, path: `/session/${encodedSessionId}/message`, bodyBase64: toOpenCodeMessageBody(input.bodyBase64) });
    }
    if (input.method === 'POST' && action === 'prompt') {
      return this.forward({ ...input, path: `/session/${encodedSessionId}/message`, bodyBase64: toOpenCodeMessageBody(input.bodyBase64) });
    }
    if (input.method === 'POST' && action === 'command') {
      return this.forward({ ...input, path: `/session/${encodedSessionId}/command`, bodyBase64: toOpenCodeCommandBody(input.bodyBase64) });
    }
    if (input.method === 'POST' && action === 'abort') {
      return this.forward({ ...input, path: `/session/${encodedSessionId}/abort` });
    }
    if (input.method === 'POST' && action === 'update') {
      return this.forward({ ...input, path: `/session/${encodedSessionId}`, annotateBackend: true });
    }
    if (input.method === 'POST' && action === 'fork') {
      return this.forward({ ...input, path: `/session/${encodedSessionId}/fork`, annotateBackend: true });
    }

    return this.json(404, { error: 'Harness route not found' });
  }

  private async getControlSurface(apiUrl: string, headers: Record<string, string>, parsed: URL): Promise<ApiProxyResponsePayload> {
    const directory = parsed.searchParams.get('directory');
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const [agents, providers, commands] = await Promise.all([
      this.fetchJson(apiUrl, `/app/agents${query}`, headers).catch(() => []),
      this.fetchJson(apiUrl, `/config/providers${query}`, headers).catch(() => ({})),
      this.fetchJson(apiUrl, `/command${query}`, headers).catch(() => []),
    ]);

    const rawAgents = Array.isArray(agents) ? agents : [];
    const visibleAgents = rawAgents
      .filter((agent) => isRecord(agent) && agent.mode !== 'subagent' && agent.hidden !== true && (isRecord(agent.options) ? agent.options.hidden !== true : true))
      .map((agent) => {
        const name = typeof agent.name === 'string' ? agent.name : '';
        return {
          id: name,
          label: name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Unknown',
          ...(typeof agent.description === 'string' && agent.description.trim() ? { description: agent.description.trim() } : {}),
          ...(typeof agent.color === 'string' && agent.color.trim() ? { color: agent.color.trim() } : {}),
        };
      });

    const providersPayload = isRecord(providers) ? providers : {};
    const providerMap = isRecord(providersPayload.providers) ? providersPayload.providers : {};
    const providerId = parsed.searchParams.get('providerId') || (isRecord(providersPayload.default) && typeof providersPayload.default.chat === 'string' ? providersPayload.default.chat : undefined) || Object.keys(providerMap)[0];
    const provider = providerId && isRecord(providerMap[providerId]) ? providerMap[providerId] : null;
    const providerModels = provider && isRecord(provider.models) ? provider.models : {};
    const modelId = parsed.searchParams.get('modelId') || Object.keys(providerModels)[0];
    const model = modelId && isRecord(providerModels[modelId]) ? providerModels[modelId] : null;
    const variants = model && isRecord(model.variants) ? Object.keys(model.variants) : [];
    const modelOptions = Object.entries(providerModels).map(([id, modelEntry]) => {
      const record = isRecord(modelEntry) ? modelEntry : {};
      const label = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
      const modelVariants = isRecord(record.variants) ? Object.keys(record.variants) : [];
      return {
        id,
        label,
        ...(modelVariants.length > 0 ? { optionDescriptors: [{ id: 'variant', label: 'Thinking', type: 'select', options: modelVariants.map((variant) => ({ id: variant, label: capitalize(variant) })) }] } : {}),
        raw: record,
      };
    });
    const commandItems = (Array.isArray(commands) ? commands : [])
      .filter((command) => isRecord(command) && typeof command.name === 'string' && command.name.trim())
      .map((command) => ({
        id: String(command.name).trim(),
        label: String(command.name).trim(),
        ...(typeof command.description === 'string' && command.description.trim() ? { description: command.description.trim() } : {}),
        raw: command,
      }));

    return this.json(200, {
      backendId: 'opencode',
      providerSnapshot: {
        backendId: 'opencode',
        label: 'OpenCode',
        enabled: true,
        auth: { status: 'unknown' },
        capabilities: { chat: true, sessions: true, models: true, commands: true, providers: true, auth: true, config: true, skills: true, shell: true },
        models: modelOptions,
        interactionModes: visibleAgents,
        commands: commandItems,
        raw: providersPayload,
      },
      modeSelector: { kind: 'agent', label: 'Agent', items: visibleAgents },
      modelSelector: { label: 'Model', source: 'providers' },
      effortSelector: { label: 'Thinking', source: 'model-variants', defaultOptionId: null, options: variants.map((variant) => ({ id: variant, label: capitalize(variant) })) },
      commandSelector: { source: 'config', items: commandItems.map((command) => ({ name: command.id, ...(command.description ? { description: command.description } : {}), executionMode: 'session-command' })) },
    });
  }

  private async fetchJson(apiUrl: string, path: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(new URL(path.replace(/^\/+/, ''), `${apiUrl.replace(/\/+$/, '')}/`).toString(), { headers });
    return response.json().catch(() => null);
  }

  private async forward(input: HarnessForwardInput): Promise<ApiProxyResponsePayload> {
    return forwardApiRequest({ ...input, deps: this.deps });
  }

  private json(status: number, payload: unknown): ApiProxyResponsePayload {
    return { status, headers: { 'content-type': 'application/json' }, bodyBase64: this.deps.base64EncodeUtf8(JSON.stringify(payload)) };
  }
}

const isRecord = (value: unknown): value is JsonRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const decodeJsonBody = (bodyBase64: string | undefined): JsonRecord | null => {
  if (!bodyBase64) return null;
  try {
    const parsed = JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const encodeJsonBody = (body: JsonRecord | null, fallback: string | undefined): string | undefined => {
  if (!body) return fallback;
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
};

const getRequestedBackendId = (url: URL, body: JsonRecord | null): string => {
  const queryBackendId = url.searchParams.get('backendId');
  if (queryBackendId?.trim()) return queryBackendId.trim();
  const bodyBackendId = body?.backendId;
  return typeof bodyBackendId === 'string' && bodyBackendId.trim() ? bodyBackendId.trim() : 'opencode';
};

const withSearch = (path: string, params: URLSearchParams): string => {
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};

const getRunConfigOption = (runConfig: unknown, optionId: string): string | undefined => {
  if (!isRecord(runConfig) || !Array.isArray(runConfig.options)) return undefined;
  const option = runConfig.options.find((entry) => isRecord(entry) && entry.id === optionId);
  return isRecord(option) && typeof option.value === 'string' ? option.value : undefined;
};

const toRuntimeModel = (runConfig: unknown): string | undefined => {
  if (!isRecord(runConfig) || !isRecord(runConfig.model)) return undefined;
  const providerId = typeof runConfig.model.providerId === 'string' ? runConfig.model.providerId : undefined;
  const modelId = typeof runConfig.model.modelId === 'string' ? runConfig.model.modelId : undefined;
  if (providerId && modelId) return `${providerId}/${modelId}`;
  return modelId;
};

const toOpenCodeMessageBody = (bodyBase64: string | undefined): string | undefined => {
  const body = decodeJsonBody(bodyBase64);
  if (!body) return bodyBase64;
  const runConfig = body.runConfig;
  return encodeJsonBody({
    ...body,
    ...(body.model ? {} : { model: toRuntimeModel(runConfig) }),
    ...(body.agent ? {} : isRecord(runConfig) && typeof runConfig.interactionMode === 'string' ? { agent: runConfig.interactionMode } : {}),
    ...(body.variant ? {} : { variant: getRunConfigOption(runConfig, 'variant') ?? getRunConfigOption(runConfig, 'effort') }),
    ...(body.messageId && !body.messageID ? { messageID: body.messageId } : {}),
  }, bodyBase64);
};

const toOpenCodeCommandBody = (bodyBase64: string | undefined): string | undefined => {
  const body = decodeJsonBody(bodyBase64);
  if (!body) return bodyBase64;
  const runConfig = body.runConfig;
  return encodeJsonBody({
    ...body,
    ...(body.model ? {} : { model: toRuntimeModel(runConfig) }),
    ...(body.agent ? {} : isRecord(runConfig) && typeof runConfig.interactionMode === 'string' ? { agent: runConfig.interactionMode } : {}),
    ...(body.variant ? {} : { variant: getRunConfigOption(runConfig, 'variant') ?? getRunConfigOption(runConfig, 'effort') }),
    ...(typeof body.commandId === 'string' && !body.command ? { command: body.commandId } : {}),
    ...(body.messageId && !body.messageID ? { messageID: body.messageId } : {}),
  }, bodyBase64);
};

async function forwardApiRequest(input: ForwardRequestInput): Promise<ApiProxyResponsePayload> {
  const targetUrl = new URL(input.path.replace(/^\/+/, ''), `${input.apiUrl.replace(/\/+$/, '')}/`).toString();
  const response = await fetch(targetUrl, {
    method: input.method,
    headers: input.headers,
    body:
      typeof input.bodyBase64 === 'string' && input.bodyBase64.length > 0 && input.method !== 'GET' && input.method !== 'HEAD'
        ? Buffer.from(input.bodyBase64, 'base64')
        : undefined,
  });

  const arrayBuffer = await response.arrayBuffer();
  let bodyBase64 = Buffer.from(arrayBuffer).toString('base64');
  if (input.annotateBackend) {
    bodyBase64 = annotateBackend(bodyBase64);
  }

  return {
    status: response.status,
    headers: input.deps.collectHeaders(response.headers),
    bodyBase64,
  };
}

function annotateBackend(bodyBase64: string): string {
  try {
    const decoded = Buffer.from(bodyBase64, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (Array.isArray(parsed)) {
      return Buffer.from(JSON.stringify(parsed.map((entry) => isRecord(entry) ? { ...entry, backendId: 'opencode' } : entry)), 'utf8').toString('base64');
    }
    if (isRecord(parsed)) {
      return Buffer.from(JSON.stringify({ ...parsed, backendId: 'opencode' }), 'utf8').toString('base64');
    }
  } catch {
    // Leave non-JSON bodies unchanged.
  }
  return bodyBase64;
}

export async function handleProxyBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ProxyRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:proxy': {
      const { method, path: requestPath, headers, bodyBase64 } = (payload || {}) as ApiProxyRequestPayload;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      const localFsResponse = await deps.tryHandleLocalFsProxy(normalizedMethod, normalizedPath);
      if (localFsResponse) {
        return { id, type, success: true, data: localFsResponse };
      }

      if (normalizedMethod === 'GET' && normalizedPath === '/openchamber/backends') {
        const settings = deps.readSettings(ctx);
        const configuredDefaultBackend =
          typeof settings?.defaultBackend === 'string' && settings.defaultBackend.trim().length > 0
            ? settings.defaultBackend.trim()
            : DEFAULT_BACKEND_ID;
        const backends = BACKEND_DESCRIPTORS.map((descriptor) => ({
          ...descriptor,
          capabilities: { ...descriptor.capabilities },
        }));
        const body = JSON.stringify({
          defaultBackend: configuredDefaultBackend,
          backends,
        });
        const data: ApiProxyResponsePayload = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }

      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      const harnessRuntime = new HarnessRuntimeManager(deps);
      const harnessResponse = await harnessRuntime.handle({
        method: normalizedMethod,
        path: normalizedPath,
        headers: requestHeaders,
        bodyBase64,
        apiUrl,
      });
      if (harnessResponse) {
        return { id, type, success: true, data: harnessResponse };
      }

      const requestBodyBase64 = bodyBase64;

      if (normalizedPath === '/event' || normalizedPath === '/global/event') {
        if (!requestHeaders.Accept) {
          requestHeaders.Accept = 'text/event-stream';
        }
        requestHeaders['Cache-Control'] = requestHeaders['Cache-Control'] || 'no-cache';
        requestHeaders.Connection = requestHeaders.Connection || 'keep-alive';
      }

      try {
        const response = await fetch(targetUrl, {
          method: normalizedMethod,
          headers: requestHeaders,
          body:
            typeof requestBodyBase64 === 'string' && requestBodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
              ? Buffer.from(requestBodyBase64, 'base64')
              : undefined,
        });

        const arrayBuffer = await response.arrayBuffer();
        const responseBodyBase64 = Buffer.from(arrayBuffer).toString('base64');
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: responseBodyBase64,
        };

        return { id, type, success: true, data };
      } catch (error) {
        const body = JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to reach OpenCode API',
        });
        const data: ApiProxyResponsePayload = {
          status: 502,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    case 'api:session:message': {
      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const { path: requestPath, headers, bodyText } = (payload || {}) as ApiSessionMessageRequestPayload;
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      if (!/^\/session\/[^/]+\/message(?:\?.*)?$/.test(normalizedPath)) {
        const body = JSON.stringify({ error: 'Invalid session message proxy path' });
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: typeof bodyText === 'string' ? bodyText : '',
          signal: AbortSignal.timeout(45000),
        });

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };

        return { id, type, success: true, data };
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          ((error as Error & { name?: string }).name === 'TimeoutError' ||
            (error as Error & { name?: string }).name === 'AbortError');
        const body = JSON.stringify({
          error: isTimeout ? 'OpenCode message forward timed out' : error instanceof Error ? error.message : 'OpenCode message forward failed',
        });
        const data: ApiProxyResponsePayload = {
          status: isTimeout ? 504 : 503,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    default:
      return null;
  }
}
