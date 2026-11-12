import type { promises as fsPromises } from 'node:fs';
import type { PlatformPath } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Prompt id to override text; an empty string is a value. */
export type MagicPromptOverrides = Record<string, string>;

export type MagicPromptGlobalState = { version: number; overrides: MagicPromptOverrides };

export type MagicPromptScopeState =
  | { status: 'ok' | 'missing'; overrides: MagicPromptOverrides }
  | { status: 'invalid'; reason: string };

/** A registered project: its id, and the checkout that holds its shared file. */
export type MagicPromptProject = { id: string; path: string };

/**
 * The owner of `<checkout>/.openchamber/project.json`. `updateSharedProjectEntry`
 * refuses an invalid file with `code: 'shared_config_invalid'` and a gone
 * checkout with the message `project checkout not found`.
 */
type SharedProjectFileOwner = {
  readSharedProjectFile: (
    projectPath: string,
  ) => Promise<{ status: 'missing' } | { status: 'ok'; document: { [key: string]: JsonValue } } | { status: 'invalid'; reason: string }>;
  updateSharedProjectEntry: (
    projectId: string,
    projectPath: string,
    key: string,
    mutate: (stored: JsonValue | undefined) => JsonValue | undefined,
  ) => Promise<JsonValue | undefined>;
};

export type MagicPromptRuntime = {
  readPromptState: () => Promise<MagicPromptGlobalState>;
  setOverride: (id: string | null, text: string) => Promise<MagicPromptGlobalState>;
  resetOverride: (id: string | null) => Promise<MagicPromptGlobalState>;
  resetAllOverrides: () => Promise<MagicPromptGlobalState>;
};

export type ProjectMagicPromptRuntime = {
  readProjectState: (project: MagicPromptProject) => Promise<MagicPromptScopeState>;
  setOverride: (project: MagicPromptProject, id: string | null, text: string) => Promise<void>;
  resetOverride: (project: MagicPromptProject, id: string | null) => Promise<void>;
  resetAllOverrides: (project: MagicPromptProject) => Promise<void>;
};

export function createMagicPromptRuntime(dependencies: {
  fsPromises: Pick<typeof fsPromises, 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>;
  path: PlatformPath;
  filePath: string;
}): MagicPromptRuntime;

export function createProjectMagicPromptRuntime(dependencies: { projectConfigRuntime: SharedProjectFileOwner }): ProjectMagicPromptRuntime;
