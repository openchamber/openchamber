import type { PlatformPath } from 'node:path';

import type {
  MagicPromptGlobalState,
  MagicPromptOverrides,
  MagicPromptProject,
  MagicPromptRuntime,
  MagicPromptScopeState,
  ProjectMagicPromptRuntime,
} from './runtime.js';

/** One `/api/magic-prompts` request: every query value of each selector name, and what the routes read from the body. */
export type MagicPromptRequest = {
  method: 'GET' | 'PUT' | 'DELETE';
  /** The prompt id of `/api/magic-prompts/:id`, `null` for the collection. */
  id: string | null;
  projectId: string[];
  scope: string[];
  sessionDirectory: string[];
  /** `body.text` when it is a string. */
  text: string | null;
  /** True when the body carries `scope` or `projectId`. */
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
  /** The registered projects, read at call time. */
  listProjects: () => MagicPromptProject[] | Promise<MagicPromptProject[]>;
  /** The registered project that owns work in `directory`, or `null`. */
  ownerOfDirectory: (directory: string) => Promise<MagicPromptProject | null>;
}): {
  handle: (request: MagicPromptRequest) => Promise<MagicPromptHttpResponse>;
  overridesForDirectory: (directory: string) => Promise<MagicPromptOverrides>;
};
