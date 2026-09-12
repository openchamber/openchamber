import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-vscode-skills-test-'));
const fakeGitPath = path.join(testRoot, 'git');
const gitLogPath = path.join(testRoot, 'git.log');
const fakeGitSource = `#!/bin/sh
log="$OPENCHAMBER_VSCODE_SKILLS_GIT_LOG"
mode="$OPENCHAMBER_VSCODE_SKILLS_GIT_MODE"
printf 'args:%s\\n' "$*" >> "$log"
printf 'marker:%s prompt:%s\\n' "$OPENCHAMBER_TEST_AUTH_MARKER" "$GIT_TERMINAL_PROMPT" >> "$log"
if [ "$1" = "--version" ]; then
  printf 'git version 2.0\\n'
  exit 0
fi
if [ "$1" = "clone" ]; then
  target=""
  has_filter=0
  for arg in "$@"; do
    target="$arg"
    if [ "$arg" = "--filter=blob:none" ]; then has_filter=1; fi
  done
  mkdir -p "$target/skills/example/nested"
  if [ "$mode" = "auth" ]; then
    printf 'fatal: Authentication failed for origin\\n' >&2
    exit 1
  fi
  if [ "$mode" = "fallback" ] && [ "$has_filter" -eq 1 ]; then
    printf 'filter unsupported\\n' >&2
    exit 1
  fi
  printf '%s\\n' '---' 'description: Example skill' '---' 'Body' > "$target/skills/example/SKILL.md"
  printf 'nested file\\n' > "$target/skills/example/nested/notes.md"
  exit 0
fi
if [ "$mode" = "sparse-failure" ] && [ "$1" = "-C" ] && [ "$3" = "sparse-checkout" ] && [ "$4" = "set" ]; then
  printf 'sparse checkout unavailable\\n' >&2
  exit 1
fi
if [ "$mode" = "hold-materialization" ] && [ "$1" = "-C" ] && [ "$3" = "sparse-checkout" ] && [ "$4" = "set" ]; then
  touch "$OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_STARTED"
  while [ ! -f "$OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_RELEASE" ]; do sleep 0.01; done
fi
if [ "$1" = "-C" ] && [ "$3" = "ls-files" ]; then
  printf 'skills/example/SKILL.md\\n'
  exit 0
fi
exit 0
`;
await fs.writeFile(fakeGitPath, fakeGitSource, { mode: 0o755 });

let configuredGit = fakeGitPath;
const executableCalls = [];
const executableResolver = async () => {
  executableCalls.push(configuredGit);
  return configuredGit;
};
const leaseEvents = [];
const activeDestinations = new Set();
const materializationStartedPath = path.join(testRoot, 'materialization-started');
const materializationReleasePath = path.join(testRoot, 'materialization-release');

const executionRuntime = {
  coordinator: {
    runClone: async (options, task) => {
      activeDestinations.add(options.destination);
      let networkActive = true;
      const releaseNetwork = () => {
        if (!networkActive) return;
        networkActive = false;
        leaseEvents.push({ event: 'network-released', active: activeDestinations.has(options.destination) });
      };
      try {
        return await task({
          releaseNetwork,
        });
      } finally {
        releaseNetwork();
        leaseEvents.push({ event: 'task-finished', active: activeDestinations.has(options.destination) });
        activeDestinations.delete(options.destination);
      }
    },
  },
};

process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_LOG = gitLogPath;
process.env.OPENCHAMBER_TEST_AUTH_MARKER = 'configured-auth';

const { installSkillsFromRepository, scanSkillsRepository } = await import('./skillsCatalog');

const dependencies = { resolveGitExecutable: executableResolver, gitExecutionRuntime: executionRuntime };

const clearGitLog = async () => {
  await fs.writeFile(gitLogPath, '');
  await fs.rm(materializationStartedPath, { force: true });
  await fs.rm(materializationReleasePath, { force: true });
  leaseEvents.length = 0;
};

const readGitLog = async () => fs.readFile(gitLogPath, 'utf8');

const waitForFile = async (filePath) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
};

const cloneTargetsFromLog = (log) => log
  .split('\n')
  .filter((line) => line.startsWith('args:clone '))
  .map((line) => line.split(' ').at(-1))
  .filter(Boolean);

beforeEach(async () => {
  await clearGitLog();
  executableCalls.length = 0;
  configuredGit = fakeGitPath;
  process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'success';
  process.env.OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_STARTED = materializationStartedPath;
  process.env.OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_RELEASE = materializationReleasePath;
});

afterAll(async () => {
  delete process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_LOG;
  delete process.env.OPENCHAMBER_TEST_AUTH_MARKER;
  delete process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE;
  delete process.env.OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_STARTED;
  delete process.env.OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_RELEASE;
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('VS Code skills catalog Git execution', () => {
  it('holds network capacity during partial-clone materialization', async () => {
    process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'hold-materialization';

    const scan = scanSkillsRepository({ source: 'owner/skills', defaultSubpath: 'skills' }, dependencies);
    await waitForFile(materializationStartedPath);
    expect(leaseEvents).toEqual([]);

    await fs.writeFile(materializationReleasePath, 'release');
    await expect(scan).resolves.toMatchObject({
      ok: true,
      items: [{ skillName: 'example', description: 'Example skill' }],
    });
    expect(leaseEvents).toEqual([
      { event: 'network-released', active: true },
      { event: 'task-finished', active: true },
    ]);
  });

  it('uses the configured executable, preserves auth environment, falls back, and cleans up after sparse local processing', async () => {
    process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'fallback';

    const result = await scanSkillsRepository({
      source: 'owner/skills',
      defaultSubpath: 'skills',
    }, dependencies);

    expect(result).toMatchObject({
      ok: true,
      items: [{ skillName: 'example', description: 'Example skill' }],
    });
    expect(executableCalls.length).toBeGreaterThan(0);
    const log = await readGitLog();
    expect(log).toContain(`marker:configured-auth prompt:0`);
    expect(log).toContain('args:clone --depth 1 --filter=blob:none --no-checkout');
    expect(log).toContain('args:clone --depth 1 --no-checkout');
    const targets = cloneTargetsFromLog(log);
    expect(targets.length).toBe(2);
    for (const target of targets) {
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(leaseEvents).toEqual([
      { event: 'network-released', active: true },
      { event: 'task-finished', active: true },
    ]);
  });

  it('maps authentication failures without treating them as a generic clone error', async () => {
    process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'auth';

    await expect(scanSkillsRepository({ source: 'owner/private' }, dependencies)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'authRequired', sshOnly: true },
    });
    expect((await readGitLog()).match(/^args:clone /gm)).toHaveLength(2);
  });

  it('returns Git unavailable when the configured executable cannot be spawned', async () => {
    configuredGit = path.join(testRoot, 'missing-git');

    await expect(scanSkillsRepository({ source: 'owner/skills' }, dependencies)).resolves.toEqual({
      ok: false,
      error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' },
    });
    expect((await readGitLog()).trim()).toBe('');
  });

  it('installs sparse-selected files locally and holds the destination lease through cleanup', async () => {
    process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'fallback';
    const workingDirectory = await fs.mkdtemp(path.join(testRoot, 'working-'));

    const result = await installSkillsFromRepository({
      source: 'owner/skills',
      scope: 'project',
      workingDirectory,
      selections: [{ skillDir: 'skills/example' }],
    }, dependencies);

    expect(result).toEqual({
      ok: true,
      installed: [{ skillName: 'example', scope: 'project', source: 'opencode' }],
      skipped: [],
    });
    await expect(fs.readFile(path.join(workingDirectory, '.opencode', 'skills', 'example', 'nested', 'notes.md'), 'utf8')).resolves.toBe('nested file\n');
    const log = await readGitLog();
    for (const target of cloneTargetsFromLog(log)) {
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(leaseEvents).toEqual([
      { event: 'network-released', active: true },
      { event: 'task-finished', active: true },
    ]);
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });
});
