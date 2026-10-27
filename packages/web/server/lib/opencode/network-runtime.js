export const createOpenCodeNetworkRuntime = (deps) => {
  const {
    state,
    getOpenCodeAuthHeaders,
  } = deps;

  const normalizeApiPrefix = (prefix) => {
    if (!prefix) {
      return '';
    }

    if (prefix.includes('://')) {
      try {
        const parsed = new URL(prefix);
        return normalizeApiPrefix(parsed.pathname);
      } catch {
        return '';
      }
    }

    const trimmed = prefix.trim();
    if (!trimmed || trimmed === '/') {
      return '';
    }
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
  };

  // OpenCode v2 mounts its HTTP API under /api (v1 served it at the root). Callers that pass an
  // empty/omitted prefix want "the default API surface", which for v2 is /api.
  const DEFAULT_OPENCODE_API_PREFIX = '/api';

  // Readiness probe. v2 has no /global/health; /api/info answers 200. Probe both so this works
  // against either API generation.
  const READY_PATHS = ['/api/info', '/global/health'];

  const waitForReady = async (url, timeoutMs = 10000) => {
    const start = Date.now();
    const base = url.replace(/\/+$/, '');
    while (Date.now() - start < timeoutMs) {
      for (const path of READY_PATHS) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const response = await fetch(`${base}${path}`, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              ...getOpenCodeAuthHeaders(),
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (response.ok) {
            const body = await response.json().catch(() => null);
            // /api/info has no `healthy` flag; a 200 JSON is sufficient. /global/health must say so.
            if (body?.healthy === true || path === '/api/info') {
              return true;
            }
          }
        } catch {
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const setDetectedOpenCodeApiPrefix = () => {
    state.openCodeApiPrefix = DEFAULT_OPENCODE_API_PREFIX;
    state.openCodeApiPrefixDetected = true;
    if (state.openCodeApiDetectionTimer) {
      clearTimeout(state.openCodeApiDetectionTimer);
      state.openCodeApiDetectionTimer = null;
    }
  };

  const buildOpenCodeUrl = (path, prefixOverride) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const requestedPrefix = prefixOverride !== undefined && prefixOverride !== ''
      ? prefixOverride
      : DEFAULT_OPENCODE_API_PREFIX;
    const prefix = normalizeApiPrefix(requestedPrefix);
    const fullPath = `${prefix}${normalizedPath}`;
    const base = state.openCodeBaseUrl ?? `http://localhost:${state.openCodePort}`;
    return `${base}${fullPath}`;
  };

  const detectOpenCodeApiPrefix = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = DEFAULT_OPENCODE_API_PREFIX;
    return true;
  };

  const ensureOpenCodeApiPrefix = () => detectOpenCodeApiPrefix();

  const scheduleOpenCodeApiDetection = () => {
    return;
  };

  return {
    waitForReady,
    normalizeApiPrefix,
    setDetectedOpenCodeApiPrefix,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    scheduleOpenCodeApiDetection,
  };
};
