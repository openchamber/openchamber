import type { PlatformPath } from 'node:path';

import type {
  MagicPromptGlobalState,
  MagicPromptOverrides,
  MagicPromptProject,
  MagicPromptRuntime,
  MagicPromptScopeState,
  ProjectMagicPromptRuntime,
} from './runtime.js';

export type MagicPromptRequest = {
  method: 'GET' | 'PUT' | 'DELETE';
  id: string | null;
  projectId: string[];
  scope: string[];
  sessionDirectory: string[];
  text: string | null;
  bodyNamesSelector: boolean;
};

type ScopedView = {
  version: number;
  project: { id: string; path: string; file: string };
  scopes: { global: MagicPromptScopeState; project: MagicPromptScopeState };
};

export type MagicPromptHttpResponse = { status: number; body: MagicPromptGlobalState | ScopedView | { error: string; code?: string } };

export function createMagicPromptService(dependencies: {
  path: PlatformPath;
  runtime: MagicPromptRuntime;
  projectRuntime: ProjectMagicPromptRuntime;
  listProjects: () => MagicPromptProject[] | Promise<MagicPromptProject[]>;
  ownerOfDirectory: (directory: string) => Promise<MagicPromptProject | null>;
}): {
  handle: (request: MagicPromptRequest) => Promise<MagicPromptHttpResponse>;
  overridesForDirectory: (directory: string) => Promise<MagicPromptOverrides>;
};
