import { runtimeFetch } from '@/lib/runtime-fetch';

export interface AntigravityModel {
  id: string;
  name: string;
}

export interface AntigravityStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  models: AntigravityModel[];
  /** Why the model list is empty although the CLI is installed (sign-in, quota). */
  error: { code: string; message: string } | null;
  /** Enterprise mode: the CLI is not run at all. */
  blocked: boolean;
  /** False when OpenChamber talks to an external OpenCode server. */
  managed: boolean;
  checkedAt: number;
}

const asModel = (value: unknown): AntigravityModel | null => {
  if (!value || typeof value !== 'object') return null;
  const model = value as Record<string, unknown>;
  if (typeof model.id !== 'string' || model.id.length === 0) return null;
  return { id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id };
};

/**
 * Parse the status route at the boundary. The page decides what to show from
 * this shape alone, so an unexpected payload is a failed read rather than a
 * half-filled screen.
 */
export const parseAntigravityStatus = (value: unknown): AntigravityStatus | null => {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.installed !== 'boolean') return null;
  const error = payload.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown>
    : null;
  return {
    installed: payload.installed,
    binaryPath: typeof payload.binaryPath === 'string' ? payload.binaryPath : null,
    version: typeof payload.version === 'string' ? payload.version : null,
    models: Array.isArray(payload.models)
      ? payload.models.map(asModel).filter((model): model is AntigravityModel => model !== null)
      : [],
    error: error && typeof error.code === 'string'
      ? { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
      : null,
    blocked: payload.blocked === true,
    managed: payload.managed !== false,
    checkedAt: typeof payload.checkedAt === 'number' ? payload.checkedAt : Date.now(),
  };
};

/**
 * Read the CLI's state on the host that runs OpenCode. `refresh` asks the
 * server to skip its short cache, for a user who just signed in or installed
 * the CLI.
 */
export const fetchAntigravityStatus = async ({ refresh = false } = {}): Promise<AntigravityStatus> => {
  const response = await runtimeFetch('/api/antigravity/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    ...(refresh ? { query: { refresh: '1' } } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = body && typeof body.error === 'string' && body.error ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const parsed = parseAntigravityStatus(await response.json().catch(() => null));
  if (!parsed) throw new Error('The Antigravity status response was not readable');
  return parsed;
};
