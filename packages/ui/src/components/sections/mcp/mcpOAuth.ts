export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

type McpOAuthStatePayload = {
  v: 1;
  n: string;
  d: string | null;
};

const decodeBase64Url = (value: string): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const binary = window.atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

export const parseMcpOAuthCallbackContext = (params: URLSearchParams): {
  name: string;
  directory: string | null;
} | null => {
  const stateContext = parseMcpOAuthState(params.get('state'));
  if (stateContext) {
    return stateContext;
  }

  const server = params.get('server');
  if (typeof server !== 'string' || !server.trim()) {
    return null;
  }

  const directory = params.get('directory');
  return {
    name: server.trim(),
    directory: typeof directory === 'string' && directory.trim() ? directory.trim() : null,
  };
};

export const parseMcpOAuthCallbackStateKey = (params: URLSearchParams): string | null => {
  const rawState = params.get('state');
  if (typeof rawState !== 'string') {
    return null;
  }

  const trimmed = rawState.trim();
  return trimmed || null;
};

export const parseMcpOAuthState = (raw: string | null | undefined): {
  name: string;
  directory: string | null;
} | null => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  const decoded = decodeBase64Url(raw.trim());
  if (!decoded) {
    return null;
  }

  try {
    const payload = JSON.parse(decoded) as Partial<McpOAuthStatePayload>;
    if (payload?.v !== 1 || typeof payload.n !== 'string' || !payload.n.trim()) {
      return null;
    }

    return {
      name: payload.n.trim(),
      directory: typeof payload.d === 'string' && payload.d.trim() ? payload.d.trim() : null,
    };
  } catch {
    return null;
  }
};
