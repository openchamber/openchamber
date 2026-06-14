export const PI_HARNESS_RUNTIME = 'pi-harness';
export const DEFAULT_PI_HARNESS_URL = 'http://127.0.0.1:8080';
export const DEFAULT_PI_PROVIDER_ID = 'pi-harness';
export const DEFAULT_PI_MODEL_ID = 'pi-default';

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

export function isPiHarnessRuntimeEnabled(env = process.env) {
  return clean(env.OPENCHAMBER_BACKEND_RUNTIME).toLowerCase() === PI_HARNESS_RUNTIME;
}

export function normalizeBaseUrl(value) {
  const raw = clean(value) || DEFAULT_PI_HARNESS_URL;
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function resolvePiHarnessConfig(env = process.env) {
  const enabled = isPiHarnessRuntimeEnabled(env);
  return {
    enabled,
    baseUrl: normalizeBaseUrl(env.PI_HARNESS_URL),
    apiKey: clean(env.PI_HARNESS_API_KEY) || null,
    providerID: clean(env.PI_HARNESS_PROVIDER) || DEFAULT_PI_PROVIDER_ID,
    modelID: clean(env.PI_HARNESS_MODEL) || DEFAULT_PI_MODEL_ID,
    workspaceRoot: clean(env.PI_HARNESS_WORKSPACE) || null,
  };
}
