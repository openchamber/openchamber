import type { McpDraft } from '@/stores/useMcpConfigStore';

export interface ImportedMcpResult {
  readonly ok: true;
  readonly name?: string;
  readonly type: 'local' | 'remote';
  readonly command: string[];
  readonly url: string;
  readonly environment: Array<{ key: string; value: string }>;
  readonly headers: Array<{ key: string; value: string }>;
  readonly oauthEnabled: boolean;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly oauthScope: string;
  readonly oauthRedirectUri: string;
  readonly timeout: string;
  readonly enabled: boolean;
}

export type ImportedMcpError =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly error: string; readonly parsed: unknown };

export type ImportedMcpOutcome = ImportedMcpResult | ImportedMcpError;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function buildError(message: string, parsed?: unknown): ImportedMcpError {
  return parsed !== undefined
    ? { ok: false, error: message, parsed }
    : { ok: false, error: message };
}

function buildResult(
  name: string | undefined,
  type: 'local' | 'remote',
  raw: Record<string, unknown>,
): ImportedMcpResult {
  const command: string[] = buildCommand(raw);
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';

  const environment = buildEnv(raw, 'env', 'environment');
  const headers = buildEnv(raw, 'headers');

  const oauthEnabled = buildOAuthEnabled(raw);
  const oauthClientId = typeof raw.oauth === 'object' && raw.oauth !== null
    ? String((raw.oauth as Record<string, unknown>).clientId ?? '').trim()
    : '';
  const oauthClientSecret = typeof raw.oauth === 'object' && raw.oauth !== null
    ? String((raw.oauth as Record<string, unknown>).clientSecret ?? '').trim()
    : '';
  const oauthScope = typeof raw.oauth === 'object' && raw.oauth !== null
    ? String((raw.oauth as Record<string, unknown>).scope ?? '').trim()
    : '';
  const oauthRedirectUri = typeof raw.oauth === 'object' && raw.oauth !== null
    ? String((raw.oauth as Record<string, unknown>).redirectUri ?? '').trim()
    : '';

  const timeout = buildTimeout(raw);

  const enabled = buildEnabled(raw);

  return {
    ok: true,
    name,
    type,
    command,
    url,
    environment,
    headers,
    oauthEnabled,
    oauthClientId,
    oauthClientSecret,
    oauthScope,
    oauthRedirectUri,
    timeout,
    enabled,
  };
}

function buildCommand(raw: Record<string, unknown>): string[] {
  const cmd = raw.command;
  const args = raw.args;

  if (stringArray(cmd) && stringArray(args)) {
    return [...cmd, ...args];
  }
  if (stringArray(cmd)) {
    return cmd;
  }
  if (typeof cmd === 'string' && cmd.trim()) {
    const parts = cmd.trim().split(/\s+/);
    if (stringArray(args)) {
      return [...parts, ...args];
    }
    return parts;
  }
  if (stringArray(args)) {
    return args;
  }

  return [];
}

function buildEnv(
  raw: Record<string, unknown>,
  ...keys: string[]
): Array<{ key: string; value: string }> {
  for (const key of keys) {
    const val = raw[key];
    if (!isObject(val)) continue;

    const entries = Object.entries(val as Record<string, unknown>).filter(
      ([k, v]) => k && typeof v === 'string',
    );
    if (entries.length > 0) {
      return entries.map(([k, v]) => ({ key: k, value: String(v) }));
    }
  }
  return [];
}

function buildOAuthEnabled(raw: Record<string, unknown>): boolean {
  if (raw.oauth === false || raw.oauth === null || raw.oauth === undefined) {
    return false;
  }
  if (!isObject(raw.oauth)) {
    return false;
  }
  const oauth = raw.oauth as Record<string, unknown>;
  return !!(
    (typeof oauth.clientId === 'string' && oauth.clientId.trim()) ||
    (typeof oauth.clientSecret === 'string' && oauth.clientSecret.trim()) ||
    (typeof oauth.scope === 'string' && oauth.scope.trim()) ||
    (typeof oauth.redirectUri === 'string' && oauth.redirectUri.trim())
  );
}

function buildTimeout(raw: Record<string, unknown>): string {
  const t = raw.timeout;
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
    return String(Math.floor(t));
  }
  if (typeof t === 'string' && t.trim()) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) {
      return String(Math.floor(n));
    }
  }
  return '';
}

function buildEnabled(raw: Record<string, unknown>): boolean {
  if ('disabled' in raw && raw.disabled === true) {
    return false;
  }
  if ('enabled' in raw) {
    return Boolean(raw.enabled);
  }
  return true;
}

/**
 * Extract a single named server entry from a parsed JSON object.
 * Returns null if the shape does not contain exactly one identifiable server.
 */
function extractSingleServer(
  obj: Record<string, unknown>,
): { name: string; entry: Record<string, unknown> } | null {
  const mcpServers = obj.mcpServers;
  if (isObject(mcpServers)) {
    const keys = Object.keys(mcpServers);
    if (keys.length === 1) {
      const name = keys[0]!;
      const entry = mcpServers[name];
      if (isObject(entry)) {
        return { name, entry };
      }
    }
    if (keys.length > 1) {
      return null;
    }
  }

  const serverKeys = Object.keys(obj).filter((k) => {
    const v = obj[k];
    return k !== 'mcpServers' && isObject(v);
  });

  if (serverKeys.length === 1) {
    const name = serverKeys[0]!;
    const entry = obj[name] as Record<string, unknown>;
    if (isServerConfig(entry)) {
      return { name, entry };
    }
  }

  return null;
}

function isServerConfig(val: Record<string, unknown>): boolean {
  return (
    val.type === 'local' ||
    val.type === 'remote' ||
    Array.isArray(val.command) ||
    typeof val.url === 'string' ||
    Array.isArray(val.args)
  );
}

/**
 * Parse a raw JSON string as an MCP server snippet and return normalized result
 * or a structured error.  Does not mutate the current draft — caller applies
 * the result to form state.
 *
 * Supported shapes:
 *   { "mcpServers": { "name": { ... } } }
 *   { "name": { ... } }
 *   { ...serverConfig }
 */
export function parseImportedMcpSnippet(
  raw: string,
  options?: { fallbackName?: string },
): ImportedMcpOutcome {
  let parsed: unknown;
  try {
    const trimmed = raw.trim();
    if (!trimmed) {
      return buildError('No JSON content provided');
    }
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return buildError(
      err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON',
    );
  }

  if (!isObject(parsed)) {
    return buildError('Expected a JSON object, not an array or primitive');
  }

  const obj = parsed as Record<string, unknown>;

  // Detect single named entry inside { "mcpServers": { "name": { ... } } }
  const mcpServers = obj.mcpServers;
  if (isObject(mcpServers)) {
    const keys = Object.keys(mcpServers);
    if (keys.length === 0) {
      return buildError('mcpServers object is empty', parsed);
    }
    if (keys.length > 1) {
      return buildError(
        'Paste one server at a time. Found ' +
          keys.length +
          ' servers in mcpServers',
        parsed,
      );
    }
    const serverName = keys[0]!;
    const entry = mcpServers[serverName];
    if (!isObject(entry)) {
      return buildError('Server entry is not a valid object', parsed);
    }
    return buildResult(serverName, inferType(entry as Record<string, unknown>), entry as Record<string, unknown>);
  }

  // Detect single named entry { "serverName": { ... } }
  const single = extractSingleServer(obj);
  if (single) {
    return buildResult(
      single.name,
      inferType(single.entry),
      single.entry,
    );
  }

  // Treat top-level as a bare server config
  if (isServerConfig(obj)) {
    const type = inferType(obj);
    const name = typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : options?.fallbackName;
    return buildResult(name, type, obj);
  }

  return buildError(
    'No recognizable MCP server configuration found in JSON',
    parsed,
  );
}

function inferType(entry: Record<string, unknown>): 'local' | 'remote' {
  if (entry.type === 'remote') return 'remote';
  if (entry.type === 'local') return 'local';
  if (typeof entry.url === 'string' && entry.url.trim()) return 'remote';
  if (Array.isArray(entry.command) || typeof entry.command === 'string') return 'local';
  if (Array.isArray(entry.args)) return 'local';
  return 'local';
}

/**
 * Apply an imported result to a new or existing McpDraft.
 * All fields from the result override the draft, but fields only
 * relevant to the opposite transport type are cleared.
 */
export function applyImportedMcpToDraft(
  result: ImportedMcpResult,
  currentDraft: Partial<McpDraft> & { name?: string },
  options?: { isNewServer?: boolean },
): Partial<McpDraft> & { name: string } {
  const isNew = options?.isNewServer ?? false;
  const importedName = result.name;
  const name = isNew && importedName ? importedName : currentDraft.name ?? '';

  const draft: Partial<McpDraft> & { name: string } = {
    ...currentDraft,
    name,
    type: result.type,
    command: result.type === 'local' ? result.command : [],
    url: result.type === 'remote' ? result.url : '',
    environment: result.environment,
    headers: result.type === 'remote' ? result.headers : [],
    oauthEnabled: result.type === 'remote' ? result.oauthEnabled : false,
    oauthClientId: result.type === 'remote' ? result.oauthClientId : '',
    oauthClientSecret: result.type === 'remote' ? result.oauthClientSecret : '',
    oauthScope: result.type === 'remote' ? result.oauthScope : '',
    oauthRedirectUri: result.type === 'remote' ? result.oauthRedirectUri : '',
    timeout: result.type === 'remote' ? result.timeout : '',
    enabled: result.enabled,
  };

  return draft;
}