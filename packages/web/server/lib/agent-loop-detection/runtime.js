import {
  buildToolFingerprint,
  detectLoopFromWindow,
} from './fingerprint.js';

const FETCH_TIMEOUT_MS = 10_000;
const MESSAGE_FETCH_LIMIT = 8;
const DEFAULT_IDENTICAL_THRESHOLD = 3;
const DEFAULT_NEAR_THRESHOLD = 3;
const DEFAULT_WINDOW_SIZE = 12;
const DEFAULT_NEAR_SIMILARITY = 0.92;
const DEFAULT_COOLDOWN_MS = 30_000;
const SEEN_CALL_LIMIT = 500;
const SESSION_STATE_LIMIT = 200;

const parsePositiveInt = (raw, fallback) => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const parseFloatClamped = (raw, fallback, min, max) => {
  const value = Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

const parseBool = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

/**
 * Resolve loop-detection config from env (and optional overrides for tests).
 *
 * OPENCHAMBER_AGENT_LOOP_DETECTION   — enable/disable (default true)
 * OPENCHAMBER_AGENT_LOOP_THRESHOLD   — identical repeat count before stop (default 3)
 * OPENCHAMBER_AGENT_LOOP_NEAR_THRESHOLD — near-identical count before warn (default 3)
 * OPENCHAMBER_AGENT_LOOP_WINDOW      — rolling window size (default 12)
 * OPENCHAMBER_AGENT_LOOP_NEAR_SIMILARITY — 0..1 Dice threshold (default 0.92)
 * OPENCHAMBER_AGENT_LOOP_BEHAVIOR    — auto | stop | warn (default auto)
 *   auto: identical → stop (abort, no continue); near-identical → warn (abort + recover prompt)
 *   stop: always abort without recovery
 *   warn: always abort + inject recovery prompt
 */
export const resolveLoopDetectionConfig = (env = process.env) => {
  const behaviorRaw = String(env.OPENCHAMBER_AGENT_LOOP_BEHAVIOR ?? 'auto').trim().toLowerCase();
  const behavior = behaviorRaw === 'stop' || behaviorRaw === 'warn' ? behaviorRaw : 'auto';
  return {
    enabled: parseBool(env.OPENCHAMBER_AGENT_LOOP_DETECTION, true),
    identicalThreshold: parsePositiveInt(env.OPENCHAMBER_AGENT_LOOP_THRESHOLD, DEFAULT_IDENTICAL_THRESHOLD),
    nearThreshold: parsePositiveInt(
      env.OPENCHAMBER_AGENT_LOOP_NEAR_THRESHOLD,
      parsePositiveInt(env.OPENCHAMBER_AGENT_LOOP_THRESHOLD, DEFAULT_NEAR_THRESHOLD),
    ),
    windowSize: parsePositiveInt(env.OPENCHAMBER_AGENT_LOOP_WINDOW, DEFAULT_WINDOW_SIZE),
    nearSimilarity: parseFloatClamped(env.OPENCHAMBER_AGENT_LOOP_NEAR_SIMILARITY, DEFAULT_NEAR_SIMILARITY, 0.5, 1),
    behavior,
    cooldownMs: parsePositiveInt(env.OPENCHAMBER_AGENT_LOOP_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
  };
};

const buildRecoveryPrompt = ({ kind, tool, path, count }) => {
  const target = path ? `"${path}"` : `tool "${tool}"`;
  const mode = kind === 'identical' ? 'identical' : 'near-identical';
  return [
    '<system-reminder>',
    `OpenChamber stopped this run because the agent repeated the same ${mode} ${tool} action on ${target} ${count} times without meaningful progress.`,
    'Do not repeat the same edit or tool call. Change approach: re-read the file, verify the intended change, try a different strategy, or ask the user for guidance.',
    'Acknowledge briefly what loop was detected and the next distinct step you will take. Do not continue the previous repeated action.',
    '</system-reminder>',
  ].join('\n');
};

const extractToolPart = (payload) => {
  if (!payload || payload.type !== 'message.part.updated') return null;
  const part = payload.properties?.part;
  if (!part || part.type !== 'tool') return null;
  const status = part.state?.status;
  // Count completed and error terminal states — both burn tokens on a loop.
  if (status !== 'completed' && status !== 'error') return null;
  return part;
};

export const createAgentLoopDetectionRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  config: configOverride,
  fetchImpl,
  now = () => Date.now(),
  log = console,
  onDetection,
} = {}) => {
  const getConfig = () => configOverride ?? resolveLoopDetectionConfig();
  const sessions = new Map();
  const pendingRecovery = new Map();
  const inflight = new Set();
  let stopped = false;

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query } = {}) => {
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const runner = fetchImpl ?? fetch;
    const response = await runner(`${buildOpenCodeUrl(fetchPath, '')}${search ? `?${search}` : ''}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => null);
  };

  const getSessionState = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        window: [],
        seenCallIds: new Set(),
        cooldownUntil: 0,
        directory: '',
      };
      sessions.set(sessionId, state);
      if (sessions.size > SESSION_STATE_LIMIT) {
        sessions.delete(sessions.keys().next().value);
      }
    }
    return state;
  };

  const clearSessionHistory = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) return;
    state.window = [];
    state.seenCallIds.clear();
  };

  const rememberCall = (state, fingerprint, windowSize) => {
    if (fingerprint.callId) {
      if (state.seenCallIds.has(fingerprint.callId)) return false;
      state.seenCallIds.add(fingerprint.callId);
      if (state.seenCallIds.size > SEEN_CALL_LIMIT) {
        const first = state.seenCallIds.values().next().value;
        state.seenCallIds.delete(first);
      }
    }
    state.window.push(fingerprint);
    while (state.window.length > windowSize) state.window.shift();
    return true;
  };

  const resolveAction = (kind, behavior) => {
    if (behavior === 'stop') return 'stop';
    if (behavior === 'warn') return 'warn';
    return kind === 'identical' ? 'stop' : 'warn';
  };

  const injectRecovery = async (sessionId, directory, detection) => {
    const recent = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_FETCH_LIMIT) },
    });
    if (!Array.isArray(recent) || recent.length === 0) {
      throw new Error('no recent messages for recovery prompt');
    }
    const executionInfo = recent.toReversed().find((message) =>
      message?.info?.role === 'assistant' && message.info.summary !== true)?.info;
    const providerID = typeof executionInfo?.providerID === 'string' ? executionInfo.providerID : '';
    const modelID = typeof executionInfo?.modelID === 'string' ? executionInfo.modelID : '';
    if (!providerID || !modelID) throw new Error('no assistant provider/model for recovery prompt');
    const agent = typeof executionInfo?.agent === 'string'
      ? executionInfo.agent
      : (typeof executionInfo?.mode === 'string' ? executionInfo.mode : undefined);

    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      directory,
      method: 'POST',
      body: {
        model: { providerID, modelID },
        ...(typeof agent === 'string' && agent ? { agent } : {}),
        parts: [{ type: 'text', text: buildRecoveryPrompt(detection), synthetic: true }],
      },
    });
  };

  const flushRecovery = async (sessionId, directoryHint = '') => {
    const pending = pendingRecovery.get(sessionId);
    if (!pending) return;
    const directory = directoryHint || pending.directory || '';
    clearSessionHistory(sessionId);
    await injectRecovery(sessionId, directory, pending.detection);
    pendingRecovery.delete(sessionId);
    log.warn?.(
      `[agent-loop-detection] injected recovery prompt after ${pending.detection.kind} loop `
      + `(session=${sessionId}, tool=${pending.detection.tool}, path=${pending.detection.path || '(none)'})`,
    );
  };

  const intervene = async (sessionId, directory, detection, action) => {
    const state = getSessionState(sessionId);
    const config = getConfig();
    state.cooldownUntil = now() + config.cooldownMs;
    clearSessionHistory(sessionId);

    const target = detection.path || detection.tool;
    log.warn?.(
      `[agent-loop-detection] ${detection.kind} loop detected `
      + `(action=${action}, tool=${detection.tool}, path=${target || '(none)'}, `
      + `count=${detection.count}, session=${sessionId})`,
    );
    onDetection?.({ sessionId, directory, detection, action });

    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/abort`, {
      directory,
      method: 'POST',
    });

    if (action !== 'warn') {
      pendingRecovery.delete(sessionId);
      return;
    }

    pendingRecovery.set(sessionId, { directory, detection });
    // Prefer an immediate recovery prompt after abort is accepted. If OpenCode
    // still considers the session busy, leave pendingRecovery for the idle handler.
    try {
      await flushRecovery(sessionId, directory);
    } catch (error) {
      log.warn?.(
        `[agent-loop-detection] recovery prompt deferred until idle: ${error?.message || error}`,
      );
    }
  };

  const observeToolPart = (part, directoryHint = '') => {
    if (stopped) return null;
    const config = getConfig();
    if (!config.enabled) return null;

    const sessionId = typeof part.sessionID === 'string' ? part.sessionID.trim() : '';
    if (!sessionId) return null;

    const fingerprint = buildToolFingerprint(part);
    if (!fingerprint) return null;

    const state = getSessionState(sessionId);
    if (directoryHint) state.directory = directoryHint;
    if (now() < state.cooldownUntil) return null;
    if (!rememberCall(state, fingerprint, config.windowSize)) return null;

    const detection = detectLoopFromWindow(state.window, {
      identicalThreshold: config.identicalThreshold,
      nearThreshold: config.nearThreshold,
      nearSimilarity: config.nearSimilarity,
    });
    if (!detection) return null;

    const action = resolveAction(detection.kind, config.behavior);
    if (inflight.has(sessionId)) return detection;
    inflight.add(sessionId);
    const directory = directoryHint || state.directory || '';
    void intervene(sessionId, directory, detection, action)
      .catch((error) => {
        log.warn?.(`[agent-loop-detection] intervene failed: ${error?.message || error}`);
      })
      .finally(() => {
        inflight.delete(sessionId);
      });
    return detection;
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped || !payload || typeof payload !== 'object') return null;

    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      if (info?.role === 'user' && typeof info.sessionID === 'string') {
        clearSessionHistory(info.sessionID);
        pendingRecovery.delete(info.sessionID);
      }
      return null;
    }

    if (payload.type === 'session.status') {
      const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
      const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
      const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
      const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
      const type = typeof status.type === 'string'
        ? status.type.trim()
        : (typeof info.type === 'string' ? info.type.trim() : '');
      if (sessionId && type === 'idle' && pendingRecovery.has(sessionId)) {
        const directory = typeof properties.directory === 'string' && properties.directory
          ? properties.directory
          : (directoryHint || '');
        const run = async () => {
          // Wait out an in-flight abort/intervene so idle is not dropped.
          while (inflight.has(sessionId) && !stopped) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (stopped || !pendingRecovery.has(sessionId)) return;
          inflight.add(sessionId);
          try {
            await flushRecovery(sessionId, directory);
          } finally {
            inflight.delete(sessionId);
          }
        };
        void run().catch((error) => {
          log.warn?.(`[agent-loop-detection] recovery prompt failed: ${error?.message || error}`);
        });
      }
      return null;
    }

    const part = extractToolPart(payload);
    if (!part) return null;
    return observeToolPart(part, directoryHint);
  };

  const stop = () => {
    stopped = true;
    pendingRecovery.clear();
    sessions.clear();
  };

  return {
    processPayload,
    observeToolPart,
    stop,
    // test helpers
    _getSessionState: getSessionState,
    _pendingRecovery: pendingRecovery,
  };
};
