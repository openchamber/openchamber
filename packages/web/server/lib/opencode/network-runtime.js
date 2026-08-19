const OPEN_CODE_HEALTH_PATHS = {
  legacy: '/global/health',
  opencode2: '/api/health',
};
const HEALTH_PROBE_ATTEMPT_TIMEOUT_MS = 1000;

export const detectOpenCodeProtocol = async (baseUrl, options = {}) => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const protocols = options.preferredProtocol && OPEN_CODE_HEALTH_PATHS[options.preferredProtocol]
    ? [options.preferredProtocol, ...Object.keys(OPEN_CODE_HEALTH_PATHS).filter((protocol) => protocol !== options.preferredProtocol)]
    : Object.keys(OPEN_CODE_HEALTH_PATHS);

  for (const protocol of protocols) {
    if (options.signal?.aborted) return null;

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal.reason);
    const timeout = setTimeout(
      () => controller.abort(),
      options.attemptTimeoutMs ?? HEALTH_PROBE_ATTEMPT_TIMEOUT_MS
    );
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const response = await fetch(`${normalizedBaseUrl}${OPEN_CODE_HEALTH_PATHS[protocol]}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...(options.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const body = await response.json().catch(() => null);
      if (body?.healthy === true) {
        return { protocol };
      }
    } catch {
      if (options.signal?.aborted) return null;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  return null;
};

export const createOpenCodeNetworkRuntime = (deps) => {
  const {
    state,
    getOpenCodeAuthHeaders,
    configuredOpenCodeHostname = '127.0.0.1',
  } = deps;

  const resolveConnectHostname = () => {
    const raw = typeof configuredOpenCodeHostname === 'string' ? configuredOpenCodeHostname.trim() : '';
    const hostname = raw || '127.0.0.1';
    if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
      return '127.0.0.1';
    }
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname;
    }
    return hostname.includes(':') ? `[${hostname}]` : hostname;
  };

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

  const waitForReady = async (url, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 3000);
        const result = await detectOpenCodeProtocol(url, {
          headers: getOpenCodeAuthHeaders(),
          preferredProtocol: state.openCodeProtocol,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        timeout = null;

        if (result) {
          state.openCodeProtocol = result.protocol;
          return true;
        }
      } catch {
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const setDetectedOpenCodeApiPrefix = () => {
    state.openCodeApiPrefix = '';
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
    const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
    const fullPath = `${prefix}${normalizedPath}`;
    const base = state.openCodeBaseUrl ?? `http://${resolveConnectHostname()}:${state.openCodePort}`;
    return `${base}${fullPath}`;
  };

  const detectOpenCodeApiPrefix = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = '';
    return true;
  };

  const ensureOpenCodeApiPrefix = () => detectOpenCodeApiPrefix();

  const scheduleOpenCodeApiDetection = () => {
    return;
  };

  const getOpenCodeHealthPath = () => OPEN_CODE_HEALTH_PATHS[state.openCodeProtocol] ?? OPEN_CODE_HEALTH_PATHS.legacy;

  return {
    waitForReady,
    normalizeApiPrefix,
    setDetectedOpenCodeApiPrefix,
    buildOpenCodeUrl,
    getOpenCodeHealthPath,
    ensureOpenCodeApiPrefix,
    scheduleOpenCodeApiDetection,
  };
};
