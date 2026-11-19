export const ANTIGRAVITY_ACCOUNTS_PATHS: string[];

export function readJsonFile(filePath: string): unknown;
export function getAuthEntry(auth: Readonly<Record<string, unknown>>, aliases: readonly string[]): unknown;
export function normalizeAuthEntry(entry: unknown): object | null;

export interface ConfigApiKeyOptions {
  configDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveConfigApiKey(value: unknown, options?: ConfigApiKeyOptions): string | null;
