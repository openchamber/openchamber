import { OpenCode } from '@opencode/client';

// The running OpenCode instance is the only transport this module has. It is
// wired once from `server/index.js`, and re-read on every call because the
// port and the server password both move across an OpenCode restart.
let connection = null;

/**
 * Wires this module to the running OpenCode instance. Pass `null` to detach.
 * Until it is wired, every lookup answers "no client", which the callers
 * report as "no small model available" rather than guessing.
 */
export function configureOpenCodeRuntimeProviders(next) {
  connection = next ?? null;
}

/**
 * Drops anything cached about the running instance. An OpenCode restart can
 * change the port, the password and the model list.
 */
export function resetOpenCodeRuntimeProviders() {
  modelCache = null;
  modelCacheKey = '';
  modelCacheAt = 0;
}

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

/**
 * A `@opencode/client` bound to the running instance and scoped to
 * `directory`, or `null` when OpenCode is not reachable yet.
 *
 * Built per call on purpose: `OpenCode.make` only closes over a base URL and
 * headers, and both change when OpenCode restarts.
 */
export function getSmallModelClient(directory) {
  if (!connection) return null;
  let baseUrl;
  try {
    baseUrl = stripTrailingSlash(connection.buildOpenCodeUrl('', ''));
  } catch {
    // The port is not known yet — OpenCode has not finished starting.
    return null;
  }
  const headers = { ...connection.getOpenCodeAuthHeaders() };
  if (typeof directory === 'string' && directory.trim()) {
    headers['x-opencode-directory'] = encodeURIComponent(directory.trim());
  }
  return OpenCode.make({ baseUrl, headers });
}

const MODEL_CACHE_TTL_MS = 30_000;
let modelCache = null;
let modelCacheKey = '';
let modelCacheAt = 0;

const unwrap = (payload) => (Array.isArray(payload?.data) ? payload.data : []);

/**
 * Every model the running OpenCode knows about for `directory`.
 *
 * Cached briefly: a generation needs the model's context and output limits,
 * and paying a round trip for them on every title or summary would be the
 * wrong trade. An empty array means "asked and got nothing", so callers fall
 * back to conservative defaults rather than refusing.
 */
export async function listModelInfos(client, directory) {
  const key = typeof directory === 'string' ? directory : '';
  if (modelCache && modelCacheKey === key && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }
  try {
    const models = unwrap(await client.model.list());
    modelCache = models;
    modelCacheKey = key;
    modelCacheAt = Date.now();
    return models;
  } catch {
    // Keep the previous answer for this directory when there is one: a
    // momentarily unreachable OpenCode must not retract model limits.
    return modelCacheKey === key && modelCache ? modelCache : [];
  }
}

export async function listProviderInfos(client) {
  try {
    return unwrap(await client.provider.list());
  } catch {
    return [];
  }
}

/**
 * The model OpenCode would pick on its own, or `null` when it cannot say.
 */
export async function getDefaultModelInfo(client) {
  try {
    const payload = await client.model.default();
    const info = payload?.data ?? payload;
    return info && typeof info === 'object' && typeof info.id === 'string' ? info : null;
  } catch {
    return null;
  }
}

/**
 * The model entry for a `provider/model` reference. `modelID` and `id` are
 * both accepted because OpenCode reports the same model under both.
 */
export function findModelInfo(models, providerID, modelID) {
  return models.find((model) => model?.providerID === providerID
    && (model.id === modelID || model.modelID === modelID)) ?? null;
}
