import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { getGitExecutionEnv } from './git-execution-scope';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-vscode-skills-test-'));
const fakeGitPath = path.join(testRoot, 'git');
const gitLogPath = path.join(testRoot, 'git.log');
const fakeGitSource = `#!/bin/sh
log="$OPENCHAMBER_VSCODE_SKILLS_GIT_LOG"
mode="$OPENCHAMBER_VSCODE_SKILLS_GIT_MODE"
printf 'args:%s\\n' "$*" >> "$log"
printf 'marker:%s prompt:%s\\n' "$OPENCHAMBER_TEST_AUTH_MARKER" "$GIT_TERMINAL_PROMPT" >> "$log"
printf 'optional:%s\\n' "$GIT_OPTIONAL_LOCKS" >> "$log"
if [ "$1" = "--version" ]; then
  printf 'git version 2.0\\n'
  exit 0
fi
if [ "$1" = "clone" ]; then
  if [ "$mode" = "output-limit" ]; then
    dd if=/dev/zero bs=1048576 count=5 >&2 2>/dev/null
    exit 1
  fi
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
  if [ "$mode" = "hold-cancel" ]; then
    touch "$OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_STARTED"
    while [ ! -f "$OPENCHAMBER_VSCODE_SKILLS_MATERIALIZATION_RELEASE" ]; do sleep 0.01; done
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

const execFileAsync = promisify(execFile);
const testExecGit = async (args, cwd, options = {}) => {
  try {
    const result = await execFileAsync(options.binary || 'git', args, {
      cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...getGitExecutionEnv() },
    });
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), exitCode: 0 };
  } catch (error) {
    return {
      stdout: String(error.stdout || ''),
      stderr: String(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? error.message : error.stderr || error.message || ''),
      exitCode: 1,
      code: String(error.code) === error.code ? error.code : undefined,
    };
  }
};

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
const { createGitExecutionCoordinator } = await import('./git-execution-coordinator');

const dependencies = {
  resolveGitExecutable: executableResolver,
  gitExecutionRuntime: executionRuntime,
  execGit: testExecGit,
};

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

  it('forwards clone cancellation without starting the fallback clone', async () => {
    process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'hold-cancel';
    const controller = new AbortController();
    const gitCalls = [];
    const execGit = async (args, _cwd, options = {}) => {
      gitCalls.push(args);
      if (args[0] === '--version') return { stdout: 'git version 2.0', stderr: '', exitCode: 0 };
      if (args[0] !== 'clone') return { stdout: '', stderr: '', exitCode: 0 };
      await fs.writeFile(materializationStartedPath, 'started');
      await new Promise((resolve) => options.signal?.addEventListener('abort', resolve, { once: true }));
      return { stdout: '', stderr: 'Git process was cancelled', exitCode: 1 };
    };
    const scan = scanSkillsRepository({
      source: 'owner/skills',
      signal: controller.signal,
    }, { ...dependencies, execGit });

    await waitForFile(materializationStartedPath);
    controller.abort();

    await expect(scan).resolves.toMatchObject({ ok: false, error: { kind: 'networkError' } });
    expect(gitCalls.filter((args) => args[0] === 'clone')).toHaveLength(1);
  });

  it('retains the clone destination and lease when Windows tree cleanup is unconfirmed', async () => {
    let leaseActive = false;
    let networkReleased = false;
    const blockedRuntime = {
      coordinator: {
        runClone: async (_options, task) => {
          leaseActive = true;
          const result = await task({
            releaseNetwork: () => { networkReleased = true; },
          });
          if (!result.cleanupBlocked) {
            leaseActive = false;
          }
          return result;
        },
      },
    };
    const blockedExecGit = async (args, cwd, options = {}) => {
      const result = await testExecGit(args, cwd, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        return {
          ...result,
          exitCode: 1,
          stderr: 'Failed to terminate the Windows process tree',
          cleanupBlocked: true,
          descendantsTerminated: false,
          rootClosed: false,
        };
      }
      return result;
    };

    const result = await scanSkillsRepository({ source: 'owner/skills' }, {
      ...dependencies,
      execGit: blockedExecGit,
      gitExecutionRuntime: blockedRuntime,
    });

    expect(result).toMatchObject({
      ok: false,
      cleanupBlocked: true,
      descendantsTerminated: false,
      error: {
        kind: 'networkError',
        cleanupBlocked: true,
        descendantsTerminated: false,
      },
    });
    expect(cloneTargetsFromLog(await readGitLog())).toHaveLength(1);
    const [target] = cloneTargetsFromLog(await readGitLog());
    await expect(fs.stat(target)).resolves.toBeTruthy();
    expect(leaseActive).toBe(true);
    expect(networkReleased).toBe(false);
    await fs.rm(target, { recursive: true, force: true });

    const workingDirectory = await fs.mkdtemp(path.join(testRoot, 'blocked-install-'));
    leaseActive = false;
    networkReleased = false;
    await clearGitLog();
    const installResult = await installSkillsFromRepository({
      source: 'owner/skills',
      scope: 'project',
      workingDirectory,
      selections: [{ skillDir: 'skills/example' }],
    }, {
      ...dependencies,
      execGit: blockedExecGit,
      gitExecutionRuntime: blockedRuntime,
    });
    expect(installResult).toMatchObject({
      ok: false,
      cleanupBlocked: true,
      error: {
        kind: 'networkError',
        cleanupBlocked: true,
        descendantsTerminated: false,
      },
    });
    const [installTarget] = cloneTargetsFromLog(await readGitLog());
    await expect(fs.stat(installTarget)).resolves.toBeTruthy();
    expect(leaseActive).toBe(true);
    expect(networkReleased).toBe(false);
    await fs.rm(installTarget, { recursive: true, force: true });
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });

  it('keeps the clone lease until delayed filesystem cleanup completes', async () => {
    let close;
    const cleanupReconciliation = {
      promise: new Promise((resolve) => { close = resolve; }),
      retire: () => close?.(),
    };
    const blockedExecGit = async (args, cwd, options = {}) => {
      const result = await testExecGit(args, cwd, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        return {
          ...result,
          exitCode: 1,
          stderr: 'Failed to terminate the Windows process tree',
          cleanupBlocked: true,
          descendantsTerminated: false,
          rootClosed: false,
          cleanupReconciliation,
        };
      }
      return result;
    };
    let releaseCleanup;
    let cleanupStarted;
    let cleanupCalls = 0;
    const cleanupWasStarted = new Promise((resolve) => { cleanupStarted = resolve; });
    const originalRm = fs.rm;

    try {
      const coordinator = createGitExecutionCoordinator({
        canonicalizeCloneDestination: async (destination) => path.resolve(destination),
      });
      let cloneTarget;
      const trackingExecGit = async (args, cwd, options = {}) => {
        const result = await blockedExecGit(args, cwd, options);
        if (args[0] === 'clone') cloneTarget = args.at(-1);
        return result;
      };
      const originalRemove = fs.rm;
      const delayedRemove = async (target, options) => {
        if (target === cloneTarget) {
          cleanupCalls += 1;
          cleanupStarted();
          await new Promise((resolve) => { releaseCleanup = resolve; });
        }
        return originalRemove(target, options);
      };
      fs.rm = delayedRemove;

      const result = await scanSkillsRepository({ source: 'owner/skills' }, {
        ...dependencies,
        execGit: trackingExecGit,
        gitExecutionRuntime: { coordinator },
      });
      expect(result).toMatchObject({ ok: false, cleanupBlocked: true });
      expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1 });
      await expect(fs.stat(cloneTarget)).resolves.toBeTruthy();

      close();
      await cleanupWasStarted;
      expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1 });
      await expect(fs.stat(cloneTarget)).resolves.toBeTruthy();

      releaseCleanup();
      for (let attempt = 0; attempt < 100 && coordinator.getStats().active !== 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(coordinator.getStats().active).toBe(0);
      let targetExists = true;
      for (let attempt = 0; attempt < 100 && targetExists; attempt += 1) {
        targetExists = await fs.stat(cloneTarget).then(() => true, () => false);
        if (targetExists) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(targetExists).toBe(false);
      expect(cleanupCalls).toBe(1);
      expect(coordinator.getStats()).toMatchObject({ active: 0, cloneDestinations: 0 });
    } finally {
      fs.rm = originalRm;
    }
  });

  it('keeps the install clone lease until delayed filesystem cleanup completes', async () => {
    const workingDirectory = await fs.mkdtemp(path.join(testRoot, 'delayed-install-'));
    let close;
    const cleanupReconciliation = {
      promise: new Promise((resolve) => { close = resolve; }),
      retire: () => close?.(),
    };
    const blockedExecGit = async (args, cwd, options = {}) => {
      const result = await testExecGit(args, cwd, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        return {
          ...result,
          exitCode: 1,
          stderr: 'Failed to terminate the Windows process tree',
          cleanupBlocked: true,
          descendantsTerminated: false,
          rootClosed: false,
          cleanupReconciliation,
        };
      }
      return result;
    };
    let releaseCleanup;
    let cleanupStarted;
    let cleanupCalls = 0;
    const cleanupWasStarted = new Promise((resolve) => { cleanupStarted = resolve; });
    const originalRm = fs.rm;

    try {
      const coordinator = createGitExecutionCoordinator({
        canonicalizeCloneDestination: async (destination) => path.resolve(destination),
      });
      let cloneTarget;
      const trackingExecGit = async (args, cwd, options = {}) => {
        const result = await blockedExecGit(args, cwd, options);
        if (args[0] === 'clone') cloneTarget = args.at(-1);
        return result;
      };
      const originalRemove = fs.rm;
      fs.rm = async (target, options) => {
        if (target === cloneTarget) {
          cleanupCalls += 1;
          cleanupStarted();
          await new Promise((resolve) => { releaseCleanup = resolve; });
        }
        return originalRemove(target, options);
      };

      const result = await installSkillsFromRepository({
        source: 'owner/skills',
        scope: 'project',
        workingDirectory,
        selections: [{ skillDir: 'skills/example' }],
      }, {
        ...dependencies,
        execGit: trackingExecGit,
        gitExecutionRuntime: { coordinator },
      });
      expect(result).toMatchObject({ ok: false, cleanupBlocked: true });
      expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1 });
      await expect(fs.stat(cloneTarget)).resolves.toBeTruthy();

      close();
      await cleanupWasStarted;
      expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1 });
      await expect(fs.stat(cloneTarget)).resolves.toBeTruthy();

      releaseCleanup();
      for (let attempt = 0; attempt < 100 && coordinator.getStats().active !== 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(coordinator.getStats().active).toBe(0);
      let targetExists = true;
      for (let attempt = 0; attempt < 100 && targetExists; attempt += 1) {
        targetExists = await fs.stat(cloneTarget).then(() => true, () => false);
        if (targetExists) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(targetExists).toBe(false);
      expect(cleanupCalls).toBe(1);
      expect(coordinator.getStats()).toMatchObject({ active: 0, cloneDestinations: 0 });
    } finally {
      fs.rm = originalRm;
      await fs.rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('rejects Git output that exceeds the bounded process buffer', async () => {
    process.env.OPENCHAMBER_VSCODE_SKILLS_GIT_MODE = 'output-limit';

    await expect(scanSkillsRepository({ source: 'owner/skills' }, dependencies)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'networkError', message: expect.stringMatching(/maxBuffer/i) },
    });
    expect((await readGitLog()).match(/^args:clone /gm)).toHaveLength(2);
  });

  it('uses the read-only lock scope for skill Git reads only', async () => {
    const previousOptionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    process.env.GIT_OPTIONAL_LOCKS = '1';
    try {
      await expect(scanSkillsRepository({ source: 'owner/skills' }, dependencies)).resolves.toMatchObject({ ok: true });

      const records = [];
      for (const line of (await readGitLog()).trim().split('\n')) {
        if (line.startsWith('args:')) records.push({ args: line.slice(5), optionalLocks: undefined });
        if (line.startsWith('optional:') && records.length > 0) records.at(-1).optionalLocks = line.slice(9);
      }
      expect(records.find((record) => record.args.startsWith('-C ') && record.args.includes('ls-files'))?.optionalLocks).toBe('0');
      expect(records.find((record) => record.args.startsWith('clone '))?.optionalLocks).toBe('1');
    } finally {
      if (previousOptionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
      else process.env.GIT_OPTIONAL_LOCKS = previousOptionalLocks;
    }
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
