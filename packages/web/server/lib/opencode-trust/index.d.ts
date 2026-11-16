export declare const OPENCODE_TRUST_REQUIRED: 'opencode_trust_required';
export declare const OPENCODE_TRUST_ROUTE: '/api/opencode/trust';

export type OpenCodeTrustItemKind = 'plugin' | 'package' | 'mcp' | 'lsp' | 'formatter' | 'shell' | 'config' | 'env' | 'file' | 'permission';

export interface OpenCodeTrustItem {
  kind: OpenCodeTrustItemKind;
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

export type OpenCodeTrustJsonBody = string | number | boolean | null | OpenCodeTrustJsonBody[] | { [key: string]: OpenCodeTrustJsonBody };

export interface OpenCodeTrustRequest {
  method: string;
  path: string;
  headers: Partial<Record<string, string | string[]>>;
  resolveSessionDirectory?: (sessionID: string, options?: { fresh?: boolean }) => Promise<string | null>;
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
  forget(directory: string): Promise<void>;
  followLocations(following: boolean): void;
}

export declare function createOpenCodeTrust(options: {
  storePath: string;
  homeDirectory?: string;
}): OpenCodeTrust;

export declare function sessionMoveOf(method: string, pathname: string): string | null;

export declare function readMoveDestination(
  readBody: (() => Promise<OpenCodeTrustJsonBody | undefined>) | undefined,
  sessionDirectory: string | null,
  homeDirectory?: string,
): Promise<{ refusal: OpenCodeTrustAnswer; destination?: undefined } | { refusal?: undefined; destination: string | null }>;
