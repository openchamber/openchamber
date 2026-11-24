
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { createMagicPromptRuntime, createProjectMagicPromptRuntime, type MagicPromptProject } from '../../web/server/lib/magic-prompts/runtime.js';
import { createMagicPromptService as createSharedMagicPromptService, type MagicPromptRequest } from '../../web/server/lib/magic-prompts/service.js';
import type { ProjectSetupStore } from './bridge-project-setup-runtime';

export type { MagicPromptHttpResponse, MagicPromptRequest } from '../../web/server/lib/magic-prompts/service.js';

const bodyFieldsSchema = z.object({ text: z.unknown(), scope: z.unknown(), projectId: z.unknown() }).partial();

export const magicPromptRequestSchema = z.object({
  method: z.enum(['GET', 'PUT', 'DELETE']),
  id: z.string().nullable(),
  query: z.object({ projectId: z.array(z.string()), scope: z.array(z.string()), sessionDirectory: z.array(z.string()) }),
  body: z.unknown(),
})
  .refine(({ method, id }) => (method === 'GET' ? id === null : method === 'DELETE' || id !== null))
  .transform(({ method, id, query, body }): MagicPromptRequest => {
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

const normalizeProjectPath = (value: string): string => {
  const replaced = value.trim().replace(/\\/g, '/').replace(/^([a-z]):/, (_match, letter: string) => `${letter.toUpperCase()}:`);
  if (replaced === '/' || /^[A-Za-z]:\/+$/.test(replaced)) return replaced.replace(/\/+$/, '/');
  return replaced.replace(/\/+$/, '');
};

const projectIdOfPath = (projectPath: string): string => {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '').trim();
  return normalized ? `path_${Buffer.from(normalized, 'utf8').toString('base64url')}` : '';
};

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

export type RepositoryWorktrees = { root: string; worktrees: string[] };

const repositoryFromPorcelain = (stdout: string): RepositoryWorktrees | null => {
  const blocks = stdout.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/));
  const pathOf = (lines: string[]): string => (lines.find((line) => line.startsWith('worktree ')) ?? '').slice('worktree '.length).trim();
  const listed = blocks.filter((lines) => pathOf(lines) !== '');
  const [primary] = listed;
  if (!primary) return null;
  return { root: pathOf(primary), worktrees: listed.filter((lines) => !lines.includes('bare')).map(pathOf) };
};

export const repositoryOfGitResult = (result: { stdout: string; stderr: string; exitCode: number }): RepositoryWorktrees | null => {
  if (result.exitCode === 0) return repositoryFromPorcelain(result.stdout);
  if (/not a git repository/i.test(result.stderr)) return null;
  throw new Error(`Could not read the git worktrees of this folder: ${result.stderr.trim() || `git exited with ${result.exitCode}`}`);
};

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
  listProjects: () => MagicPromptProject[];
  repositoryOf: (directory: string) => Promise<RepositoryWorktrees | null>;
};

export const createMagicPromptService = ({ globalFilePath, sharedFiles, listProjects, repositoryOf }: MagicPromptServiceDeps) => {
  const ownerOfDirectory = async (directory: string): Promise<MagicPromptProject | null> => {
    const projects = listProjects();
    const registered = await Promise.all(projects.map(async (project) => ({ ...project, path: normalizeProjectPath(await canonicalPath(project.path)) })));
    const target = await canonicalPath(directory);
    const direct = longestOwningProject(registered, target);
    const repository = await repositoryOf(directory);
    const mapped = repository ? primaryCheckoutPathOf(registered, repository, target) : null;
    const owner = mapped === null ? direct : (longestOwningProject(registered, mapped) ?? direct);
    return owner ? projects.find((project) => project.id === owner.id) ?? null : null;
  };

  const service = createSharedMagicPromptService({
    path,
    runtime: createMagicPromptRuntime({ fsPromises: fs.promises, path, filePath: globalFilePath }),
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
