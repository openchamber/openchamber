export interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  /** Inputs an OAuth method wants answered before authorize; see `provider-oauth.ts`. */
  prompts?: unknown;
  [key: string]: unknown;
}

export interface OAuthAuthMethodEntry {
  method: AuthMethod;
  /** Index in the full provider auth-methods array (passed to oauth authorize/callback). */
  methodIndex: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const normalizeAuthType = (method: AuthMethod): string => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

export const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

/**
 * Show the API key form when the provider declares API auth, or when auth
 * methods are still unknown (empty). OAuth-only providers must not get an
 * API key prompt.
 */
export const shouldShowApiKeyAuth = (methods: AuthMethod[]): boolean => {
  if (methods.length === 0) {
    return true;
  }
  return methods.some((method) => normalizeAuthType(method) === 'api');
};

export const getOAuthAuthMethods = (methods: AuthMethod[]): OAuthAuthMethodEntry[] =>
  methods
    .map((method, methodIndex) => ({ method, methodIndex }))
    .filter(({ method }) => normalizeAuthType(method) === 'oauth');

export const requiresOpenCodeRestartAfterOAuth = (providerId: string): boolean =>
  providerId !== 'claude-code';
