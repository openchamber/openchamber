import type { JsonValue } from '../shared/json-values.js';

export function readWorktreeDirectorySetting(
  workingDirectory: string,
  primaryWorktree?: string,
): string | null;

export const OPENCODE_CONFIG_DIR: string;
export function getOpenCodeDataDir(env?: NodeJS.ProcessEnv): string;

export function getAncestors(startDir: string | null | undefined, stopDir?: string | null): string[];
export function findWorktreeRoot(startDir: string | null | undefined): string | null;

export interface OpenCodeConfigLayer {
  [key: string]: JsonValue;
}

export interface OpenCodeConfigLayers {
  userConfig: OpenCodeConfigLayer;
  userOverrideConfig: OpenCodeConfigLayer;
  projectConfig: OpenCodeConfigLayer;
  customConfig: OpenCodeConfigLayer;
  mergedConfig: OpenCodeConfigLayer;
  paths: {
    userPath: string;
    userOverridePath: string | null;
    projectPath: string | null;
    customPath: string | null;
  };
  layerErrors: { path: string; code: string; message: string }[];
}

export function readConfigLayers(workingDirectory: string | null): OpenCodeConfigLayers;
