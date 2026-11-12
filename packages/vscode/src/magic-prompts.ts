// Magic Prompt overrides in the extension host. Storage, selectors and the
// two-scope view are the server's own modules
// (`packages/web/server/lib/magic-prompts/`, whose DOCUMENTATION.md is the
// contract); this file supplies what differs in VS Code: the bridge payload,
// the registered projects (the workspace folders), owner resolution through
// `git worktree list` and the shared-file owner `projectSetupStore`.
//
// Kept free of `vscode` imports so it is unit-tested directly; the host wires
// in the workspace folders and git.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { createMagicPromptRuntime, createProjectMagicPromptRuntime, type MagicPromptProject } from '../../web/server/lib/magic-prompts/runtime.js';
import { createMagicPromptService as createSharedMagicPromptService, type MagicPromptRequest } from '../../web/server/lib/magic-prompts/service.js';
import type { ProjectSetupStore } from './bridge-project-setup-runtime';

export type { MagicPromptHttpResponse, MagicPromptRequest } from '../../web/server/lib/magic-prompts/service.js';

const bodyFieldsSchema = z.object({ text: z.unknown(), scope: z.unknown(), projectId: z.unknown() }).partial();

/**
 * The bridge payload as the webview sends it: the method, the prompt id of
 * `/api/magic-prompts/:id` (`null` for the collection), every query value
 * of `projectId` and `scope`, and the parsed JSON body. Only the routes the
 * server has parse: GET and DELETE of the collection, PUT and DELETE of one id.
 */
export const magicPromptRequestSchema = z.object({
  method: z.enum(['GET', 'PUT', 'DELETE']),
  id: z.string().nullable(),
  query: z.object({ projectId: z.array(z.string()), scope: z.array(z.string()), sessionDirectory: z.array(z.string()) }),
  body: z.unknown(),
})
  .refine(({ method, id }) => (method === 'GET' ? id === null : method === 'DELETE' || id !== null))
  .transform(({ method, id, query, body }): MagicPromptRequest => {
    // A body that is not an object (an array, a string) carries neither field.
    const fields = bodyFieldsSchema.safeParse(body);
    const bodyRecord = fields.success ? fields.data : undefined;
    return {
      method,
      id,
      projectId: query.projectId,
      scope: query.scope,
      sessionDirectory: query.sessionDirectory,
      text: typeof bodyRecord?.text === 'string' ? bodyRecord.text : null,
      bodyNamesSelector: bodyRecord !== undefined && (Object.hasOwn(bodyRecord, 'scope') || Object.hasOwn(bodyRecord, 'projectId')),
    };
  });

/** UI path normalization (`packages/ui/src/lib/pathNormalization.ts`) for the paths ids are made from. */
const normalizeProjectPath = (value: string): string => {
  const replaced = value.trim().replace(/\\/g, '/').replace(/^([a-z]):/, (_match, letter: string) => `${letter.toUpperCase()}:`);
  if (replaced === '/' || /^[A-Za-z]:\/+$/.test(replaced)) return replaced.replace(/\/+$/, '/');
  return replaced.replace(/\/+$/, '');
};

/** The id the UI gives a VS Code workspace folder (`createProjectIdFromPath`). */
const projectIdOfPath = (projectPath: string): string => {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  return normalized ? `path_${Buffer.from(normalized, 'utf8').toString('base64url')}` : '';
};

/** The registered projects of a VS Code window: its workspace folders, as the UI lists them. */
export const workspaceProjectsOf = (folders: ReadonlyArray<{ path: string }>): MagicPromptProject[] => {
  const projects: MagicPromptProject[] = [];
  for (const folder of folders) {
    const projectPath = normalizeProjectPath(folder.path);
    const id = projectPath ? projectIdOfPath(projectPath) : '';
    if (id && !projects.some((project) => project.id === id)) projects.push({ id, path: projectPath });
  }
  return projects;
};

const isInsideCheckout = (directory: string, checkout: string): boolean =>
  directory === checkout || directory.startsWith(checkout.endsWith('/') ? checkout : `${checkout}/`);

const longestOwningProject = (projects: MagicPromptProject[], directory: string): MagicPromptProject | null => {
  const target = normalizeProjectPath(directory);
  let best: MagicPromptProject | null = null;
  for (const project of projects) {
    if (!isInsideCheckout(target, project.path)) continue;
    if (!best || project.path.length > best.path.length) best = project;
  }
  return best;
};

/** A repository as `git worktree list --porcelain` lists it: its primary root, then every non-bare checkout. */
export type RepositoryWorktrees = { root: string; worktrees: string[] };

const repositoryFromPorcelain = (stdout: string): RepositoryWorktrees | null => {
  const blocks = stdout.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/));
  const pathOf = (lines: string[]): string => (lines.find((line) => line.startsWith('worktree ')) ?? '').slice('worktree '.length).trim();
  const listed = blocks.filter((lines) => pathOf(lines) !== '');
  const [primary] = listed;
  if (!primary) return null;
  return { root: pathOf(primary), worktrees: listed.filter((lines) => !lines.includes('bare')).map(pathOf) };
};

/**
 * The repository of `git worktree list --porcelain` run in a directory, with
 * git's messages in English. `null` only when git says the directory is not
 * in a repository; any other failure throws, so owner resolution fails
 * instead of silently using global prompts for a worktree.
 */
export const repositoryOfGitResult = (result: { stdout: string; stderr: string; exitCode: number }): RepositoryWorktrees | null => {
  if (result.exitCode === 0) return repositoryFromPorcelain(result.stdout);
  if (/not a git repository/i.test(result.stderr)) return null;
  throw new Error(`Could not read the git worktrees of this folder: ${result.stderr.trim() || `git exited with ${result.exitCode}`}`);
};

/**
 * Where `directory` sits in the primary checkout when a linked checkout of
 * `repository` holds it: the same path relative to the repository root, so
 * `<worktree>/ai` maps to `<repo>/ai`. `null` when no linked checkout holds
 * it, or when a registered project at or inside that checkout holds it: such
 * a project is the worktree's own and the direct match keeps it.
 */
const primaryCheckoutPathOf = (
  projects: MagicPromptProject[],
  repository: RepositoryWorktrees,
  directory: string,
): string | null => {
  const root = normalizeProjectPath(repository.root);
  const target = normalizeProjectPath(directory);
  const checkout = repository.worktrees
    .map(normalizeProjectPath)
    .filter((candidate) => isInsideCheckout(target, candidate))
    .sort((left, right) => right.length - left.length)[0];
  if (!checkout || checkout === root) return null;
  if (projects.some((project) => isInsideCheckout(project.path, checkout) && isInsideCheckout(target, project.path))) return null;
  return path.posix.join(root, target.slice(checkout.length));
};

/**
 * A path with symlinks resolved, through its nearest existing parent when the
 * folder itself does not exist yet. Git reports checkouts this way, so
 * workspace folders opened through a symlink (`/tmp` on macOS) are compared
 * in the same form.
 */
const canonicalPath = async (value: string): Promise<string> => {
  const resolved = path.resolve(value);
  let existing = resolved;
  for (;;) {
    const real = await fs.promises.realpath(existing).catch(() => null);
    if (real) return path.join(real, path.relative(existing, resolved));
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    existing = parent;
  }
};

type MagicPromptServiceDeps = {
  globalFilePath: string;
  sharedFiles: Pick<ProjectSetupStore, 'readSharedFile' | 'updateSharedEntry'>;
  /** The registered projects, read at call time. */
  listProjects: () => MagicPromptProject[];
  /** The repository holding `directory` with its checkouts, or `null` outside a repository. */
  repositoryOf: (directory: string) => Promise<RepositoryWorktrees | null>;
};

export const createMagicPromptService = ({ globalFilePath, sharedFiles, listProjects, repositoryOf }: MagicPromptServiceDeps) => {
  /**
   * The project that owns `directory`, by the server's rule: the deepest
   * registered project holding it, except in a linked worktree, where the
   * deepest project holding the same path in the primary checkout owns it
   * (`<worktree>/ai` belongs to `<repo>/ai`), unless a project registered in
   * that worktree holds it. `null` when no registered project owns it. A
   * directory outside any repository keeps its direct owner; a git read that
   * failed rejects.
   */
  const ownerOfDirectory = async (directory: string): Promise<MagicPromptProject | null> => {
    const projects = listProjects();
    const registered = await Promise.all(projects.map(async (project) => ({ ...project, path: normalizeProjectPath(await canonicalPath(project.path)) })));
    const target = await canonicalPath(directory);
    const direct = longestOwningProject(registered, target);
    const repository = await repositoryOf(directory);
    const mapped = repository ? primaryCheckoutPathOf(registered, repository, target) : null;
    const owner = mapped === null ? direct : (longestOwningProject(registered, mapped) ?? direct);
    // The caller gets the project as it is registered, not its resolved path.
    return owner ? projects.find((project) => project.id === owner.id) ?? null : null;
  };

  const service = createSharedMagicPromptService({
    path,
    runtime: createMagicPromptRuntime({ fsPromises: fs.promises, path, filePath: globalFilePath }),
    // The store's chain is per checkout, so the project id plays no part.
    projectRuntime: createProjectMagicPromptRuntime({
      projectConfigRuntime: {
        readSharedProjectFile: sharedFiles.readSharedFile,
        updateSharedProjectEntry: (_projectId, projectPath, key, mutate) => sharedFiles.updateSharedEntry(projectPath, key, mutate),
      },
    }),
    listProjects,
    ownerOfDirectory,
  });

  return { ...service, ownerOfDirectory };
};
