export type OpenCodeCompatibility = {
  state: 'unavailable' | 'compatible' | 'incompatible';
  version: string | null;
  installation: 'managed' | 'external' | 'bundled';
  minimumVersion: string;
  canInstall: boolean;
};
type Launch = { binary: string; args: string[] };
type CliOptions = { cwd?: string; env?: NodeJS.ProcessEnv };
export function isSupportedOpenCodeVersion(version: string): boolean;
export function readOpenCodeInfo(response: Response): Promise<{ version: string } | null>;
export function readOpenCodeCliVersion(launch: Launch, options?: CliOptions): Promise<string>;
export class UnsupportedOpenCodeVersionError extends Error { version: string; constructor(version: string); }
export function requireOpenCodeV2(launch: Launch, options?: CliOptions): Promise<string>;
export function readExternalOpenCodeVersion(baseUrl: string, headers: Record<string, string>, fetchImpl?: typeof fetch): Promise<string | null>;
export function describeOpenCodeCompatibility(version: string | null, installation: OpenCodeCompatibility['installation'], canInstall: boolean): OpenCodeCompatibility;
