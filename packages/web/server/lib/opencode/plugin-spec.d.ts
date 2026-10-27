export type ParsedNpmSpec = { name: string; version: string | null };
export type MalformedSpec = { malformed: true; raw: string };
export type ParsedPathSpec = { absolutePath: string };

export function parseNpmSpec(spec: string): ParsedNpmSpec | MalformedSpec;
export function isExactSemver(version: string): boolean;
export function isPathSpec(spec: string): boolean;
export function isGitSpec(spec: string): boolean;
export function isPluginControlSpec(spec: string): boolean;
export function parsedKindForSpec(spec: string): 'control' | 'path' | 'git' | 'npm';
export function parsePathSpec(spec: string, options: { homedir: string; cwd: string }): ParsedPathSpec;
