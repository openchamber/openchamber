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

export interface ProviderCredentialInput {
  /** Present when OpenCode reports an active credential (api/env/oauth). */
  key?: string | null;
  /** OpenChamber auth.json provenance for this provider. */
  authSourceExists?: boolean | null;
}

/**
 * Prefer authoritative credential signals. Do not treat Provider.env length as
 * proof of credentials — that array is declared env var *names*, not values.
 */
export const providerHasCredentials = (input: ProviderCredentialInput): boolean => {
  if (typeof input.key === 'string' && input.key.trim().length > 0) {
    return true;
  }
  return input.authSourceExists === true;
};

export const shouldShowModelsSection = (input: {
  modelCount: number;
  sourcesLoaded: boolean;
  hasCredentials: boolean;
}): boolean => input.modelCount > 0 && (!input.sourcesLoaded || input.hasCredentials);

export const shouldAutoOpenAuthPanel = (input: {
  sourcesLoaded: boolean;
  hasCredentials: boolean;
  userDismissed: boolean;
}): boolean => input.sourcesLoaded && !input.hasCredentials && !input.userDismissed;
