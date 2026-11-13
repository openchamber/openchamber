export declare const OPENCODE_TRUST_REQUIRED: 'opencode_trust_required';
export declare const OPENCODE_TRUST_ROUTE: '/api/opencode/trust';

export type OpenCodeTrustItemKind = 'plugin' | 'package' | 'mcp' | 'lsp' | 'formatter' | 'shell' | 'config';

export interface OpenCodeTrustItem {
  kind: OpenCodeTrustItemKind;
  /** The file or plugin path, relative to the folder. */
  source: string;
  name: string;
  detail: string;
}

export interface OpenCodeTrustAssessment {
  directory: string;
  trusted: boolean;
  fingerprint: string | null;
  items: OpenCodeTrustItem[];
}

export interface OpenCodeTrustRefusal {
  error: string;
  code?: typeof OPENCODE_TRUST_REQUIRED;
  directory?: string;
}

export interface OpenCodeTrustAnswer {
  status: number;
  body: OpenCodeTrustAssessment | OpenCodeTrustRefusal;
}

/** A request body as `JSON.parse` returns it. */
export type OpenCodeTrustJsonBody = string | number | boolean | null | OpenCodeTrustJsonBody[] | { [key: string]: OpenCodeTrustJsonBody };

export interface OpenCodeTrustRequest {
  method: string;
  /** Path with query, starting at `/api`. */
  path: string;
  headers: Partial<Record<string, string | string[]>>;
  /** The folder a session runs in; null when the session does not exist, throws when it cannot tell. `fresh` skips any cache. */
  resolveSessionDirectory?: (sessionID: string, options?: { fresh?: boolean }) => Promise<string | null>;
  /** The request's JSON body; read only for a session move, whose destination is in it. */
  readBody?: () => Promise<OpenCodeTrustJsonBody | undefined>;
}

export interface OpenCodeTrustRouteRequest {
  method: string;
  query?: { directory?: string };
  body?: { directory?: string; fingerprint?: string | null };
}

export interface OpenCodeTrust {
  assess(directory: string, options?: { fresh?: boolean }): Promise<{ trusted: boolean }>;
  isTrusted(directory: string): Promise<boolean>;
  refusalFor(request: OpenCodeTrustRequest): Promise<OpenCodeTrustAnswer | null>;
  handleRoute(request: OpenCodeTrustRouteRequest): Promise<OpenCodeTrustAnswer>;
  /** OpenCode closed `directory`: its next opening is checked again. */
  forget(directory: string): Promise<void>;
  /** Whether the runtime reports every folder OpenCode closes; on, a trusted answer holds until then. */
  followLocations(following: boolean): void;
}

export declare function createOpenCodeTrust(options: {
  storePath: string;
  homeDirectory?: string;
}): OpenCodeTrust;

/** The session a request moves, decoded, or null when it is no move. */
export declare function sessionMoveOf(method: string, pathname: string): string | null;

/** The folder a move opens, resolved the way OpenCode resolves it, or a 400 refusal for a body naming none. */
export declare function readMoveDestination(
  readBody: (() => Promise<OpenCodeTrustJsonBody | undefined>) | undefined,
  sessionDirectory: string | null,
  homeDirectory?: string,
): Promise<{ refusal: OpenCodeTrustAnswer; destination?: undefined } | { refusal?: undefined; destination: string | null }>;
