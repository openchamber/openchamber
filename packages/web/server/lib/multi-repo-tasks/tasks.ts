import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GIT_LAUNCH_DIRECTORY, gitArgsIn } from '../git/git-launch.js';

const runFile = promisify(execFile);

export const TASK_MARKER_FILE = '.openchamber-task.json';
const AGENTS_FILE = 'AGENTS.md';
const INCLUDE_FILE = '.worktreeinclude';
const TASK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_PREFIX_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*$/;
const OS_FOLDER_FILES = new Set(['.DS_Store']);

export interface TaskRepositoryState {
  name: string;
  path: string;
  source: string;
  uncommitted: boolean;
  unpushedCommits: number;
  ignored: string[];
  hasSubmodules: boolean;
}

export interface TaskInspection {
  path: string;
  branch: string;
  repositories: TaskRepositoryState[];
  problems: string[];
}

export class TaskError extends Error {
  readonly status: number;
  readonly problems: string[];

  constructor(message: string, status: number, problems: string[] = []) {
    super(message);
    this.name = 'TaskError';
    this.status = status;
    this.problems = problems;
  }
}

const gitRaw = async (directory: string, args: string[]): Promise<string> => {
  const { stdout } = await runFile('git', gitArgsIn(directory, args), {
    cwd: GIT_LAUNCH_DIRECTORY,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
};

const git = async (directory: string, args: string[]): Promise<string> => (await gitRaw(directory, args)).trim();

const processFailureSchema = z.object({ stderr: z.string().trim().min(1) });
const exitFailureSchema = z.object({ code: z.number() });
const errnoSchema = z.object({ code: z.string() });
const copiedFileSchema = z.object({ path: z.string().min(1), sha256: z.string().length(64) });
const markerSchema = z.object({
  version: z.literal(1),
  branch: z.string().min(1),
  reposDir: z.string().min(1),
  copied: z.record(z.string(), z.array(copiedFileSchema)).optional(),
});
type TaskMarker = z.infer<typeof markerSchema>;
type CopiedFile = z.infer<typeof copiedFileSchema>;

const gitFailureText = (cause: unknown): string => {
  const failure = processFailureSchema.safeParse(cause);
  if (failure.success) return failure.data.stderr;
  return cause instanceof Error ? cause.message : String(cause);
};

const errnoCode = (cause: unknown): string | null => {
  const parsed = errnoSchema.safeParse(cause);
  return parsed.success ? parsed.data.code : null;
};

const gitQuery = async (directory: string, args: string[]): Promise<string | null> => {
  try {
    return await git(directory, args);
  } catch (cause) {
    if (exitFailureSchema.safeParse(cause).success) return null;
    throw cause;
  }
};

export const expandHome = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.lstat(target);
    return true;
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') return false;
    throw cause;
  }
};

const isDirectory = async (target: string): Promise<boolean> => {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (cause) {
    if (errnoCode(cause) === 'ENOENT') return false;
    throw cause;
  }
};

const sha256Of = async (file: string): Promise<string> => createHash('sha256').update(await fs.readFile(file)).digest('hex');

export const listRepositories = async (reposDirInput: string): Promise<{ reposDir: string; repositories: string[] }> => {
  const reposDir = expandHome(reposDirInput);
  if (!await isDirectory(reposDir)) {
    throw new TaskError(`Repositories folder not found: ${reposDir}`, 404);
  }
  const entries = await fs.readdir(reposDir, { withFileTypes: true });
  const repositories: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const candidate = path.join(reposDir, entry.name);
    if (await isDirectory(candidate) && await exists(path.join(candidate, '.git'))) {
      repositories.push(entry.name);
    }
  }
  repositories.sort((a, b) => a.localeCompare(b));
  return { reposDir, repositories };
};

const remoteDefaultBranch = async (repository: string): Promise<string> => {
  const read = () => gitQuery(repository, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const recorded = await read();
  if (recorded) return recorded;
  await git(repository, ['remote', 'set-head', 'origin', '--auto']);
  const detected = await read();
  if (!detected) throw new TaskError(`${path.basename(repository)}: origin has no default branch.`, 502);
  return detected;
};

const copyIncludedFiles = async (source: string, worktree: string): Promise<CopiedFile[]> => {
  const patterns = path.join(source, INCLUDE_FILE);
  if (!await exists(patterns)) return [];
  const listed = (await gitRaw(source, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${patterns}`]))
    .split('\0').filter((file) => file && file !== INCLUDE_FILE);
  if (listed.length === 0) return [];
  const ignoredByGit = (await gitRaw(source, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...listed.map((file) => `:(literal)${file}`)]))
    .split('\0').filter(Boolean);
  const copied: CopiedFile[] = [];
  for (const file of ignoredByGit) {
    const from = path.join(source, file);
    if (!(await fs.lstat(from)).isFile()) continue;
    const to = path.join(worktree, file);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    } catch (cause) {
      if (errnoCode(cause) === 'EEXIST') continue;
      throw cause;
    }
    copied.push({ path: file, sha256: await sha256Of(to) });
  }
  return copied;
};

const agentsFileText = (name: string, branch: string, reposDir: string, repositories: Array<{ name: string; base: string }>): string => {
  const rows = repositories.map((repo) => `| \`${repo.name}/\` | \`${path.join(reposDir, repo.name)}\` | \`${repo.base}\` |`).join('\n');
  return `# Task: ${name}

This folder is one task that spans several repositories. Each subfolder is a git worktree on branch \`${branch}\`, created from its repository's remote default branch.

| Folder | Source repository | Based on |
|---|---|---|
${rows}

- Work only inside these folders. Each one is its own git repository: run git inside it, and commit, push and open a pull request per repository.
- Read each repository's own \`AGENTS.md\` or \`CLAUDE.md\` before changing it.
- Other repositories live in \`${reposDir}\`. Read them for reference when needed, but never edit them there.
- If the task needs one of them, add it as a worktree of this task on the same branch:
  \`git -C ${reposDir}/<repo> fetch origin && git -C ${reposDir}/<repo> worktree add --no-track -b ${branch} ${'$'}PWD/<repo> origin/HEAD\`
`;
};

export interface CreateTaskInput {
  reposDir: string;
  tasksDir: string;
  name: string;
  branchPrefix?: string | undefined;
  repositories: string[];
}

export const createTask = async (input: CreateTaskInput): Promise<{ path: string; branch: string }> => {
  const name = input.name.trim();
  if (!TASK_NAME_PATTERN.test(name)) {
    throw new TaskError('Use letters, digits, dots, dashes or underscores for the task name, starting with a letter or digit.', 400);
  }
  const branchPrefix = (input.branchPrefix ?? '').trim();
  if (!BRANCH_PREFIX_PATTERN.test(branchPrefix)) {
    throw new TaskError('A branch prefix ends with "/", for example "me/".', 400);
  }
  const branch = `${branchPrefix}${name}`;
  const selected = [...new Set(input.repositories)];
  if (selected.length === 0) {
    throw new TaskError('Select at least one repository.', 400);
  }
  const { reposDir, repositories } = await listRepositories(input.reposDir);
  const unknown = selected.filter((repo) => !repositories.includes(repo));
  if (unknown.length > 0) {
    throw new TaskError(`Not a repository in ${reposDir}: ${unknown.join(', ')}`, 400);
  }
  if (await gitQuery(GIT_LAUNCH_DIRECTORY, ['check-ref-format', '--branch', branch]) === null) {
    throw new TaskError(`"${branch}" is not a valid branch name.`, 400);
  }

  const tasksDir = expandHome(input.tasksDir);
  const taskPath = path.join(tasksDir, name);
  if (await exists(taskPath)) {
    throw new TaskError(`${taskPath} already exists.`, 409);
  }

  const sources = selected.map((repo) => ({ name: repo, source: path.join(reposDir, repo) }));
  const branchTaken: string[] = [];
  for (const repo of sources) {
    const taken = await git(repo.source, ['branch', '--list', branch]);
    if (taken) branchTaken.push(repo.name);
  }
  if (branchTaken.length > 0) {
    throw new TaskError(`Branch ${branch} already exists in: ${branchTaken.join(', ')}`, 409, branchTaken.map((repo) => `${repo}: branch ${branch} already exists`));
  }

  const fetchFailures = (await Promise.all(sources.map(async (repo) => {
    try {
      await git(repo.source, ['fetch', '--prune', 'origin']);
      return null;
    } catch (cause) {
      return `${repo.name}: ${gitFailureText(cause)}`;
    }
  }))).filter((failure): failure is string => failure !== null);
  if (fetchFailures.length > 0) {
    throw new TaskError('Could not fetch from origin, so the task would not start from the latest default branch.', 502, fetchFailures);
  }

  const bases = await Promise.all(sources.map(async (repo) => ({ ...repo, base: await remoteDefaultBranch(repo.source) })));

  await fs.mkdir(tasksDir, { recursive: true });
  await fs.mkdir(taskPath);
  const created: typeof bases = [];
  const copied: Record<string, CopiedFile[]> = {};
  let adding: (typeof bases)[number] | null = null;
  try {
    for (const repo of bases) {
      const worktree = path.join(taskPath, repo.name);
      adding = repo;
      await git(repo.source, ['worktree', 'add', '--no-track', '-b', branch, worktree, repo.base]);
      created.push(repo);
      adding = null;
      if (await exists(path.join(worktree, '.gitmodules'))) {
        await git(worktree, ['submodule', 'update', '--init', '--recursive']);
      }
      const files = await copyIncludedFiles(repo.source, worktree);
      if (files.length > 0) copied[repo.name] = files;
    }
    const marker: TaskMarker = { version: 1, branch, reposDir };
    if (Object.keys(copied).length > 0) marker.copied = copied;
    await fs.writeFile(path.join(taskPath, TASK_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    await fs.writeFile(path.join(taskPath, AGENTS_FILE), agentsFileText(name, branch, reposDir, bases));
  } catch (cause) {
    const rollbackFailures: string[] = [];
    if (adding) await gitQuery(adding.source, ['branch', '-D', branch]);
    for (const repo of created.reverse()) {
      try {
        await git(repo.source, ['worktree', 'remove', '--force', path.join(taskPath, repo.name)]);
        await git(repo.source, ['branch', '-D', branch]);
      } catch (rollbackCause) {
        rollbackFailures.push(`${repo.name}: ${gitFailureText(rollbackCause)}`);
      }
    }
    if (rollbackFailures.length === 0) {
      await fs.rm(taskPath, { recursive: true, force: true });
    }
    throw new TaskError(`Creating the task failed: ${gitFailureText(cause)}`, 500, rollbackFailures.map((failure) => `left behind: ${failure}`));
  }
  return { path: taskPath, branch };
};

const readMarker = async (taskPath: string): Promise<TaskMarker | null> => {
  let text: string;
  try {
    text = await fs.readFile(path.join(taskPath, TASK_MARKER_FILE), 'utf8');
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw cause;
  }
  const parsed = markerSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new TaskError(`${TASK_MARKER_FILE} in ${taskPath} is not a valid task marker.`, 500);
  }
  return parsed.data;
};

const sourceRepositoryOf = async (worktree: string): Promise<string> => {
  const commonDir = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.dirname(commonDir);
};

const unchangedCopies = async (worktree: string, copied: CopiedFile[]): Promise<Set<string>> => {
  const unchanged = new Set<string>();
  for (const file of copied) {
    const current = path.join(worktree, file.path);
    if (await exists(current) && await sha256Of(current) === file.sha256) unchanged.add(file.path);
  }
  return unchanged;
};

const isOnlyUnchangedCopies = async (worktree: string, entry: string, unchanged: Set<string>): Promise<boolean> => {
  if (!entry.endsWith('/')) return unchanged.has(entry);
  if (![...unchanged].some((file) => file.startsWith(entry))) return false;
  const files = await fs.readdir(path.join(worktree, entry), { recursive: true, withFileTypes: true });
  return files.every((file) => file.isDirectory() || unchanged.has(path.relative(worktree, path.join(file.parentPath, file.name))));
};

const localState = async (worktree: string, copied: CopiedFile[]): Promise<{ uncommitted: boolean; ignored: string[] }> => {
  const unchanged = await unchangedCopies(worktree, copied);
  const entries = (await gitRaw(worktree, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal', '--ignore-submodules=none'])).split('\0');
  let uncommitted = false;
  const ignored: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') index++;
    if ((code === '??' || code === '!!') && await isOnlyUnchangedCopies(worktree, file, unchanged)) continue;
    if (code === '!!') ignored.push(file);
    else uncommitted = true;
  }
  return { uncommitted, ignored };
};

const unpushedCount = async (repository: string, refs: string[] = ['HEAD']): Promise<number> => Number(await git(repository, ['rev-list', '--count', ...refs, '--not', '--remotes']));

const submodulePaths = async (worktree: string): Promise<string[]> => {
  if (!await exists(path.join(worktree, '.gitmodules'))) return [];
  const listed = await gitRaw(worktree, ['submodule', 'foreach', '--quiet', '--recursive', 'printf "%s\\0" "$displaypath"']);
  return listed.split('\0').filter(Boolean);
};

export const inspectTask = async (taskPathInput: string): Promise<TaskInspection | null> => {
  const taskPath = expandHome(taskPathInput);
  const marker = await readMarker(taskPath);
  if (!marker) return null;

  const repositories: TaskRepositoryState[] = [];
  const problems: string[] = [];
  const entries = await fs.readdir(taskPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === TASK_MARKER_FILE || entry.name === AGENTS_FILE || OS_FOLDER_FILES.has(entry.name)) continue;
    const entryPath = path.join(taskPath, entry.name);
    const gitEntry = path.join(entryPath, '.git');
    if (!entry.isDirectory() || !await exists(gitEntry) || (await fs.lstat(gitEntry)).isDirectory()) {
      problems.push(`${entry.name}: not a worktree of this task; move or delete it first`);
      continue;
    }
    const source = await sourceRepositoryOf(entryPath);
    const { uncommitted, ignored } = await localState(entryPath, marker.copied?.[entry.name] ?? []);
    const unpushedCommits = await unpushedCount(entryPath);
    const submodules = await submodulePaths(entryPath);
    if (uncommitted) problems.push(`${entry.name}: uncommitted changes`);
    if (unpushedCommits > 0) problems.push(`${entry.name}: ${unpushedCommits} commit(s) not pushed`);
    for (const submodule of submodules) {
      const submodulePath = path.join(entryPath, submodule);
      const count = await unpushedCount(submodulePath, ['HEAD', '--branches']);
      if (count > 0) problems.push(`${entry.name}/${submodule}: ${count} submodule commit(s) not pushed`);
      const inside = await localState(submodulePath, []);
      if (inside.uncommitted) problems.push(`${entry.name}/${submodule}: uncommitted changes`);
      ignored.push(...inside.ignored.map((file) => `${submodule}/${file}`));
    }
    repositories.push({
      name: entry.name,
      path: entryPath,
      source,
      uncommitted,
      unpushedCommits,
      ignored,
      hasSubmodules: await exists(path.join(entryPath, '.gitmodules')),
    });
  }
  return { path: taskPath, branch: marker.branch, repositories, problems };
};

export const removeTask = async (taskPathInput: string): Promise<{ removed: string[] }> => {
  const inspection = await inspectTask(taskPathInput);
  if (!inspection) {
    throw new TaskError('This folder is not a multi-repo task.', 400);
  }
  if (inspection.problems.length > 0) {
    throw new TaskError('Deleting the task now would lose work.', 409, inspection.problems);
  }
  const removed: string[] = [];
  for (const repo of inspection.repositories) {
    try {
      await git(repo.source, ['worktree', 'remove', ...(repo.hasSubmodules ? ['--force'] : []), repo.path]);
      const branchExists = (await git(repo.source, ['branch', '--list', inspection.branch])).length > 0;
      const branchOnlyLocal = branchExists
        && Number(await git(repo.source, ['rev-list', '--count', inspection.branch, '--not', '--remotes'])) > 0;
      if (branchExists && !branchOnlyLocal) await git(repo.source, ['branch', '-D', inspection.branch]);
      removed.push(repo.name);
    } catch (cause) {
      throw new TaskError(`Removing ${repo.name} failed.`, 500, [
        `${repo.name}: ${gitFailureText(cause)}`,
        ...(removed.length > 0 ? [`already removed: ${removed.join(', ')}`] : []),
      ]);
    }
  }
  await fs.rm(path.join(inspection.path, AGENTS_FILE), { force: true });
  await fs.rm(path.join(inspection.path, TASK_MARKER_FILE));
  for (const file of OS_FOLDER_FILES) await fs.rm(path.join(inspection.path, file), { force: true });
  await fs.rmdir(inspection.path);
  return { removed };
};
