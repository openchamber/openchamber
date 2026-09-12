export const DEVTOOLS_ASSET_MAX_BYTES = 64 * 1024 * 1024;
export const DEVTOOLS_ASSET_MAX_PENDING = 64;
export const DEVTOOLS_ASSET_REQUEST_TIMEOUT_MS = 30_000;
export const DEVTOOLS_ROUTE_RECOVERY_TIMEOUT_MS = 2_000;

const GRANT_PATH = /^\/api\/browser-devtools\/([A-Za-z0-9_-]{32})\/inspector\.html$/;
const ROUTE_KEY = /^[a-f0-9]{32}$/;
const RECOVERY_ID = /^[a-f0-9]{32}$/;
const ASSET_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=@-]+$/;
const BOOTSTRAP_QUERY_KEYS = new Set(['parentOrigin', 'devtoolsId', 'attachmentRequestId']);

export type DevToolsAssetMethod = 'GET' | 'HEAD';

export type DevToolsAssetProxy = {
  readonly frontendUrl: string;
  readonly dispose: () => void;
};

export type DevToolsAssetProxyDependencies = {
  readonly workerUrl: string;
  readonly runtimeFetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly getRuntimeKey: () => string;
  readonly subscribeRuntimeEndpointWillChange: (listener: () => void) => () => void;
};

export type DevToolsRouteOpenMessage = {
  readonly type: 'devtools-route-open';
  readonly routeKey: string;
  readonly runtimeKey: string;
  readonly recoveryId: string | null;
};

export type DevToolsRouteRecoverMessage = {
  readonly type: 'devtools-route-recover';
  readonly routeKey: string;
  readonly recoveryId: string;
};

export type DevToolsRouteReadyMessage = {
  readonly type: 'devtools-route-ready';
  readonly routeKey: string;
  readonly runtimeKey: string;
  readonly ownerClientId: string;
};

export type DevToolsRouteCloseMessage = {
  readonly type: 'devtools-route-close';
  readonly routeKey: string;
  readonly runtimeKey: string;
};

export type DevToolsAssetRequestMessage = {
  readonly type: 'devtools-asset-request';
  readonly requestId: string;
  readonly method: DevToolsAssetMethod;
  readonly path: string;
};

export type QueuedDevToolsAssetRequest = DevToolsAssetRequestMessage & {
  readonly replyPort: MessagePort;
  readonly portSignal: AbortSignal;
};

export type DevToolsAssetResponseMessage = {
  readonly type: 'devtools-asset-response';
  readonly requestId: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: ArrayBuffer | null;
};

type ParsedDevToolsFrontendPath = {
  readonly assetRoot: string;
};

type ParsedScopedDevToolsRequest = {
  readonly routeKey: string;
  readonly ownerClientId: string;
  readonly assetPath: string;
};

export const encodeDevToolsOwnerClientId = (value: string): string | null => {
  const bytes = new TextEncoder().encode(value);
  if (!value || bytes.length > 256) return null;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const decodeDevToolsOwnerClientId = (value: string): string | null => {
  if (!/^(?:[a-f0-9]{2}){1,256}$/.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return encodeDevToolsOwnerClientId(decoded) === value ? decoded : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
};

export const parseDevToolsFrontendPath = (frontendPath: string): ParsedDevToolsFrontendPath | null => {
  if (frontendPath.includes('?') || frontendPath.includes('#') || frontendPath.includes('\\') || frontendPath.includes('%')) {
    return null;
  }
  const match = GRANT_PATH.exec(frontendPath);
  return match?.[1] ? { assetRoot: frontendPath.slice(0, -'/inspector.html'.length) } : null;
};

export const parseDevToolsAssetPath = (assetPath: string): string | null => {
  if (!assetPath || assetPath.length > 2048 || assetPath.includes('%') || assetPath.includes('\\')
    || assetPath.includes('?') || assetPath.includes('#')) return null;
  const parts = assetPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || !ASSET_SEGMENT.test(part))) return null;
  if (assetPath.startsWith('json/') || assetPath.startsWith('devtools/')) return null;
  return assetPath;
};

const hasAllowedBootstrapQuery = (url: URL, assetPath: string, origin: string): boolean => {
  if (!url.search) return true;
  if (assetPath !== 'inspector.html') return false;
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!BOOTSTRAP_QUERY_KEYS.has(key) || seen.has(key) || !value || value.length > 256) return false;
    seen.add(key);
  }
  const parentOrigin = url.searchParams.get('parentOrigin');
  if (parentOrigin !== null) {
    try {
      if (new URL(parentOrigin).origin !== origin || parentOrigin !== origin) return false;
    } catch {
      return false;
    }
  }
  return true;
};

export const parseScopedDevToolsRequest = (
  requestUrl: string,
  scopeUrl: string,
): ParsedScopedDevToolsRequest | null => {
  const url = new URL(requestUrl);
  const scope = new URL(scopeUrl);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  const parts = url.pathname.slice(scope.pathname.length).split('/');
  const encodedOwnerClientId = parts.shift();
  const routeKey = parts.shift();
  if (!encodedOwnerClientId || !routeKey || !ROUTE_KEY.test(routeKey) || parts.length === 0) return null;
  const ownerClientId = decodeDevToolsOwnerClientId(encodedOwnerClientId);
  if (!ownerClientId) return null;
  const assetPath = parseDevToolsAssetPath(parts.join('/'));
  if (!assetPath) return null;
  if (!hasAllowedBootstrapQuery(url, assetPath, scope.origin)) return null;
  return { routeKey, ownerClientId, assetPath };
};

export const isDevToolsRouteKey = (value: string): boolean => ROUTE_KEY.test(value);

export const isDevToolsRecoveryId = (value: string): boolean => RECOVERY_ID.test(value);

export const isDevToolsRuntimeKey = (value: string): boolean => {
  if (!value || value.length > 2048) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
};
