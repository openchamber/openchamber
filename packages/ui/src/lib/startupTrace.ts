export type StartupTraceEvent = {
  t: number;
  name: string;
  data?: Record<string, unknown>;
};

declare global {
  interface Window {
    __OPENCHAMBER_STARTUP_TRACE__?: StartupTraceEvent[];
    __OPENCHAMBER_STARTUP_TRACE_START__?: number;
  }
}

const MAX_STARTUP_TRACE_EVENTS = 500;

const enabled = () => {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('startupTrace') === '1' || window.localStorage?.getItem('OPENCHAMBER_STARTUP_TRACE') === '1';
  } catch {
    return false;
  }
};

export const startupTraceEnabled = () => enabled();

export const markStartupTrace = (name: string, data?: Record<string, unknown>) => {
  if (!enabled()) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  window.__OPENCHAMBER_STARTUP_TRACE_START__ ??= now;
  window.__OPENCHAMBER_STARTUP_TRACE__ ??= [];
  window.__OPENCHAMBER_STARTUP_TRACE__.push({
    t: Math.round(now - window.__OPENCHAMBER_STARTUP_TRACE_START__),
    name,
    ...(data ? { data } : {}),
  });
  if (window.__OPENCHAMBER_STARTUP_TRACE__.length > MAX_STARTUP_TRACE_EVENTS) {
    window.__OPENCHAMBER_STARTUP_TRACE__.splice(
      0,
      window.__OPENCHAMBER_STARTUP_TRACE__.length - MAX_STARTUP_TRACE_EVENTS,
    );
  }
};

export const getStartupTraceSummary = () => {
  const trace = typeof window !== 'undefined' ? window.__OPENCHAMBER_STARTUP_TRACE__ ?? [] : [];
  const readyIndex = trace.findIndex((event) => event.name === 'ModelControls:ready');
  const endIndex = readyIndex >= 0 ? Math.min(trace.length, readyIndex + 8) : trace.length;
  return trace.slice(0, endIndex).filter((event) => (
    event.name.includes('checkConnection')
    || event.name.includes('checkHealth')
    || event.name.includes('initializeApp')
    || event.name.includes('initApp')
    || event.name.includes('loadProviders')
    || event.name.includes('loadAgents')
    || event.name.includes('config.defaults')
    || event.name.includes('modelsMetadata')
    || event.name.includes('ModelControls')
    || event.name.includes('activateDirectory')
    || event.name.includes('opencodeClient:setDirectory')
  ));
};

if (typeof window !== 'undefined') {
  (window as typeof window & { __OPENCHAMBER_STARTUP_TRACE_SUMMARY__?: typeof getStartupTraceSummary })
    .__OPENCHAMBER_STARTUP_TRACE_SUMMARY__ = getStartupTraceSummary;
}

export const measureStartupTrace = async <T>(
  name: string,
  fn: () => Promise<T>,
  data?: Record<string, unknown>,
): Promise<T> => {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  markStartupTrace(`${name}:start`, data);
  try {
    const result = await fn();
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    markStartupTrace(`${name}:end`, { durationMs: Math.round(ended - started) });
    return result;
  } catch (error) {
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    markStartupTrace(`${name}:error`, {
      durationMs: Math.round(ended - started),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
