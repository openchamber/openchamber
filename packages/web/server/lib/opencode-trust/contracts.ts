import type fs from 'node:fs';
import type { Reachability } from '../directory-reachability/index.js';
import type { createOpenCodeTrust } from './index.js';

export type OpenCodeTrustItemKind = 'plugin' | 'package' | 'mcp' | 'lsp' | 'formatter' | 'shell' | 'config' | 'env' | 'file' | 'permission';

export interface OpenCodeTrustItem {
  kind: OpenCodeTrustItemKind;
  source: string;
  name: string;
  detail: string;
}

export interface FingerprintedTrustItem extends OpenCodeTrustItem {
  hash: string | null;
}

export interface ConfigAssessment {
  directory: string;
  repositoryKey: string;
  fingerprint: string | null;
  items: FingerprintedTrustItem[];
}

export interface OpenCodeTrustAssessment {
  directory: string;
  trusted: boolean;
  fingerprint: string | null;
  items: OpenCodeTrustItem[];
}

export interface OpenCodeTrustRefusal {
  error: string;
  code?: 'opencode_trust_required' | 'DIRECTORY_UNREACHABLE';
  directory?: string;
}

export interface OpenCodeTrustAnswer {
  status: number;
  body: OpenCodeTrustAssessment | OpenCodeTrustRefusal;
}

export type OpenCodeTrustJsonBody = string | number | boolean | null | OpenCodeTrustJsonBody[] | { [key: string]: OpenCodeTrustJsonBody };
export type ReadTrustBody = () => Promise<OpenCodeTrustRouteRequest['body']>;
export type SessionDirectoryResolver = (sessionID: string, options?: { fresh?: boolean }) => Promise<string | null>;

export interface OpenCodeTrustRequest {
  method: string;
  path: string;
  headers: Partial<Record<string, string | string[]>>;
  resolveSessionDirectory?: SessionDirectoryResolver;
  readBody?: ReadTrustBody;
}

export interface OpenCodeTrustRouteRequest {
  method: string;
  query?: unknown;
  body?: unknown;
}

export type OpenCodeTrust = ReturnType<typeof createOpenCodeTrust>;
export type TrustFileSystem = Pick<typeof fs.promises, 'stat' | 'lstat' | 'readdir' | 'realpath' | 'readFile' | 'mkdir'>;

export interface TrustOptions {
  storePath: string;
  listKnownDirectories?: (() => Promise<string[]>) | null;
  homeDirectory?: string;
  fsPromises?: TrustFileSystem;
  now?: () => number;
  checkDirectory?: (directory: string) => Promise<Reachability>;
}

export interface SessionDirectoryOptions {
  fetchImpl: typeof fetch;
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  now?: () => number;
}
