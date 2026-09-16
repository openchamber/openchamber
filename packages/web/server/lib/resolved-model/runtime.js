import { pathToFileURL } from 'node:url';
import { appendManagedPlugin } from '../opencode/managed-plugin-config.js';

const DEFAULT_MAX_TRACKED_SESSIONS = 2000;

/**
 * Managed plugin that reports which backing model a proxied provider actually
 * served.
 *
 * OpenCode's plugin API exposes only an OUTGOING request-headers hook
 * (`chat.headers`), so the resolved model is read from the RESPONSE headers —
 * LiteLLM-fronted gateways echo it as `x-litellm-model-name` (plus
 * `x-litellm-model-group` and `x-litellm-call-id`) regardless of which alias
 * the client asked for. Reading the raw response requires wrapping `fetch`,
 * which is why the generated plugin patches `globalThis.fetch` for the child
 * process lifetime; headers are read without touching the body, so every call
 * succeeds or fails exactly as if the plugin were absent.
 *
 * Per-session correlation: `chat.headers` tags each outgoing request with the
 * OpenCode session id, and the fetch wrapper reads that tag back out of the
 * request to key the report. Detection is by header presence, not by
 * hostname, so any LiteLLM-fronted proxy works and direct provider calls
 * simply report nothing.
 */
const createPluginSource = () => String.raw`
const SESSION_HEADER = "x-openchamber-session"
const RESOLVED_MODEL_HEADER = "x-litellm-model-name"
const MODEL_GROUP_HEADER = "x-litellm-model-group"
const CALL_ID_HEADER = "x-litellm-call-id"

let patched = false

const readSessionTag = (args) => {
  const [urlOrRequest, init] = args
  if (init?.headers) {
    const tag = new Headers(init.headers).get(SESSION_HEADER)
    if (tag) return tag
  }
  if (urlOrRequest instanceof Request) {
    return urlOrRequest.headers.get(SESSION_HEADER) || undefined
  }
  return undefined
}

export const OpenChamberResolvedModelPlugin = async () => {
  const endpoint = process.env.OPENCHAMBER_RESOLVED_MODEL_URL
  const token = process.env.OPENCHAMBER_RESOLVED_MODEL_TOKEN
  const hooks = {
    "chat.headers": async (input, output) => {
      if (input?.sessionID) output.headers[SESSION_HEADER] = input.sessionID
    },
  }
  if (!endpoint || !token || patched) return hooks
  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== "function") return hooks
  patched = true

  const report = (payload) => {
    // Reporting uses the captured original: routing it through the patched
    // fetch would re-enter the wrapper for an unrelated URL.
    try {
      void originalFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }).catch(() => {})
    } catch {
    }
  }

  globalThis.fetch = async function patchedFetch(...args) {
    const sessionID = readSessionTag(args)
    const response = await originalFetch.apply(this, args)
    try {
      if (sessionID) {
        const model = response.headers.get(RESOLVED_MODEL_HEADER)
        if (model) {
          report({
            sessionID,
            model,
            modelGroup: response.headers.get(MODEL_GROUP_HEADER) || undefined,
            callId: response.headers.get(CALL_ID_HEADER) || undefined,
          })
        }
      }
    } catch {
      // Observability never fails the real request.
    }
    return response
  }

  return hooks
}
`;

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isLoopbackAddress = (value) => {
  const address = typeof value === 'string' ? value.toLowerCase() : '';
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
};

export const createResolvedModelRuntime = (dependencies) => {
  const {
    crypto,
    fsPromises,
    path,
    dataDir,
    getActivePort,
    env = process.env,
    onModelResolved,
    maxTrackedSessions = DEFAULT_MAX_TRACKED_SESSIONS,
  } = dependencies;
  const pluginDirectory = path.join(dataDir, 'resolved-model');
  const pluginPath = path.join(pluginDirectory, 'openchamber-resolved-model-plugin.js');
  /** sessionId -> { sessionId, model, modelGroup?, callId?, updatedAt } */
  const bySessionId = new Map();
  let activeToken = null;

  const prepareManagedOpenCodeEnv = async (rawConfig) => {
    const port = getActivePort();
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('OpenChamber listener port is unavailable for resolved model monitoring');
    }
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginPath, createPluginSource(), { mode: 0o600 });
    activeToken = crypto.randomBytes(32).toString('base64url');
    return {
      OPENCODE_CONFIG_CONTENT: appendManagedPlugin(rawConfig, pathToFileURL(pluginPath).href, 'resolved model monitor'),
      OPENCHAMBER_RESOLVED_MODEL_URL: `http://127.0.0.1:${port}/api/openchamber/resolved-model/report`,
      OPENCHAMBER_RESOLVED_MODEL_TOKEN: activeToken,
    };
  };

  const authorize = (req) => {
    if (!activeToken || !isLoopbackAddress(req.socket?.remoteAddress)) return false;
    const header = asNonEmptyString(req.headers?.authorization);
    if (!header?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(activeToken);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  const recordResolution = ({ sessionID, model, modelGroup, callId }) => {
    const sessionId = asNonEmptyString(sessionID);
    const resolvedModel = asNonEmptyString(model);
    if (!sessionId || !resolvedModel) return null;
    const entry = {
      sessionId,
      model: resolvedModel,
      ...(asNonEmptyString(modelGroup) ? { modelGroup: asNonEmptyString(modelGroup) } : {}),
      ...(asNonEmptyString(callId) ? { callId: asNonEmptyString(callId) } : {}),
      updatedAt: Date.now(),
    };
    // Re-inserting moves the session to the end of Map iteration order, so the
    // size bound evicts the least recently updated session first.
    bySessionId.delete(sessionId);
    bySessionId.set(sessionId, entry);
    if (bySessionId.size > maxTrackedSessions) {
      const oldest = bySessionId.keys().next().value;
      if (oldest !== undefined) bySessionId.delete(oldest);
    }
    try {
      onModelResolved?.(entry);
    } catch {
      // A failed broadcast must not fail the report.
    }
    return entry;
  };

  const handleReport = (body) => {
    const entry = recordResolution(body && typeof body === 'object' ? body : {});
    if (!entry) return { status: 400, payload: { error: 'sessionID and model are required' } };
    return { status: 200, payload: { ok: true } };
  };

  const getSnapshot = () => Array.from(bySessionId.values());

  /** Prunes a deleted session so the map does not outlive its sessions. */
  const processPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || payload.type !== 'session.deleted') return;
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    const sessionId = asNonEmptyString(properties.sessionID) ?? asNonEmptyString(properties.info?.id);
    if (sessionId) bySessionId.delete(sessionId);
  };

  /** A managed OpenCode restart reloads providers and models; old entries lie. */
  const reset = () => {
    bySessionId.clear();
  };

  const registerCallbackRoutes = (app, express) => {
    app.post('/api/openchamber/resolved-model/report', express.json({ limit: '16kb' }), (req, res) => {
      if (!authorize(req)) return res.status(401).json({ error: 'Unauthorized' });
      const result = handleReport(req.body);
      return res.status(result.status).json(result.payload);
    });
  };

  return {
    prepareManagedOpenCodeEnv,
    registerCallbackRoutes,
    handleReport,
    getSnapshot,
    processPayload,
    reset,
  };
};
