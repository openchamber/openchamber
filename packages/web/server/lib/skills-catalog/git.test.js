import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withGitCloneReservation } from '../git/service.js';

const runGitMock = vi.fn();
const assertGitAvailableMock = vi.fn();
const looksLikeAuthErrorMock = vi.fn();

vi.mock('./git.js', () => ({
  runGit: runGitMock,
  assertGitAvailable: assertGitAvailableMock,
  looksLikeAuthError: looksLikeAuthErrorMock,
}));

const [{ scanSkillsRepository }, { installSkillsFromRepository }] = await Promise.all([
  import('./scan.js'),
  import('./install.js'),
]);

const tempPaths = [];

const createTempDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-skills-test-'));
  tempPaths.push(directory);
  return directory;
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const waitFor = async (predicate, message, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
};

const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });

const scanLocalResult = (args) => {
  if (args.includes('ls-files')) {
    return ok('skills/demo/SKILL.md\n');
  }
  if (args.includes('show')) {
    return ok('---\nname: demo\ndescription: Demo skill\n---\nBody\n');
  }
  return ok();
};

beforeEach(() => {
  runGitMock.mockReset();
  assertGitAvailableMock.mockReset().mockResolvedValue({ ok: true });
  looksLikeAuthErrorMock.mockReset().mockImplementation((message) => /permission denied|publickey/i.test(String(message || '')));
});

afterEach(() => {
  for (const target of tempPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('skills catalog clone reservations', () => {
  it('caps concurrent scan clones and releases network capacity before destination-local work finishes', async () => {
    const cloneCalls = [];
    const localGate = deferred();
    let heldDestination = '';
    let heldLocalWorkStarted = false;

    runGitMock.mockImplementation((args) => {
      if (args[0] === 'clone') {
        const gate = deferred();
        const destination = args.at(-1);
        tempPaths.push(destination);
        cloneCalls.push({ args, destination, gate });
        return gate.promise;
      }
      const destination = args[0] === '-C' ? args[1] : '';
      if (destination === heldDestination && args.includes('sparse-checkout') && args.includes('init')) {
        heldLocalWorkStarted = true;
        return localGate.promise;
      }
      return scanLocalResult(args);
    });

    const scans = Array.from({ length: 3 }, () => scanSkillsRepository({ source: 'owner/repo' }));
    try {
      await waitFor(() => cloneCalls.length === 2, 'Two network-capped scans were not admitted');
      expect(cloneCalls).toHaveLength(2);

      heldDestination = cloneCalls[0].destination;
      cloneCalls[0].gate.resolve(ok());

      await waitFor(
        () => heldLocalWorkStarted && cloneCalls.length === 3,
        'Third scan did not acquire released network capacity while local work retained its destination',
      );
      expect(cloneCalls).toHaveLength(3);

      cloneCalls[1].gate.resolve(ok());
      cloneCalls[2].gate.resolve(ok());
      localGate.resolve(ok());

      const results = await Promise.all(scans);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(results.every((result) => result.items?.[0]?.skillName === 'demo')).toBe(true);
      expect(cloneCalls.every(({ destination }) => !fs.existsSync(destination))).toBe(true);
    } finally {
      for (const call of cloneCalls) call.gate.resolve(ok());
      localGate.resolve(ok());
      await Promise.allSettled(scans);
    }
  });

  it('propagates scan fallback failure and cleans the reserved temporary destination', async () => {
    const cloneArgs = [];
    let destination = '';
    runGitMock.mockImplementation((args) => {
      if (args[0] !== 'clone') return scanLocalResult(args);
      cloneArgs.push(args);
      destination = args.at(-1);
      tempPaths.push(destination);
      if (cloneArgs.length === 1) {
        return { ok: false, stdout: '', stderr: 'partial clone unsupported', message: '' };
      }
      return { ok: false, stdout: '', stderr: 'network offline', message: 'clone failed' };
    });

    await expect(scanSkillsRepository({ source: 'owner/repo' })).resolves.toEqual({
      ok: false,
      error: { kind: 'networkError', message: 'network offline\nclone failed' },
    });
    expect(cloneArgs).toHaveLength(2);
    expect(cloneArgs[0]).toContain('--filter=blob:none');
    expect(cloneArgs[1]).not.toContain('--filter=blob:none');
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('keeps install destination ownership while releasing network after fallback clone success', async () => {
    const root = createTempDir();
    const blockerGate = deferred();
    const blockerEntered = deferred();
    const localGate = deferred();
    const fallbackGate = deferred();
    let cloneAttempts = 0;
    let cloneDestination = '';
    let localWorkStarted = false;
    let probeStarted = false;

    const blocker = withGitCloneReservation(path.join(root, 'blocker'), async () => {
      blockerEntered.resolve();
      await blockerGate.promise;
    });
    await blockerEntered.promise;

    runGitMock.mockImplementation((args) => {
      if (args[0] === 'clone') {
        cloneAttempts += 1;
        cloneDestination = args.at(-1);
        tempPaths.push(cloneDestination);
        if (cloneAttempts === 1) {
          return { ok: false, stdout: '', stderr: 'partial clone unsupported', message: '' };
        }
        return fallbackGate.promise;
      }
      if (args.includes('sparse-checkout') && args.includes('init')) {
        localWorkStarted = true;
        return localGate.promise;
      }
      return ok();
    });

    const userSkillDir = path.join(root, 'user-skills');
    const install = installSkillsFromRepository({
      source: 'owner/repo',
      scope: 'user',
      targetSource: 'opencode',
      userSkillDir,
      selections: [{ skillDir: 'skills/demo' }],
      conflictPolicy: 'overwriteAll',
    });

    let probe;
    try {
      await waitFor(() => cloneAttempts === 2, 'Install fallback clone did not start under its reservation');
      probe = withGitCloneReservation(path.join(root, 'probe'), async (lease) => {
        probeStarted = true;
        lease.releaseNetwork();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(probeStarted).toBe(false);

      const sourceDir = path.join(cloneDestination, 'skills', 'demo');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '---\nname: demo\n---\nBody\n');
      fallbackGate.resolve(ok());

      await waitFor(
        () => localWorkStarted && probeStarted,
        'Install did not release network capacity before destination-local work completed',
      );
      localGate.resolve(ok());

      await expect(install).resolves.toEqual({
        ok: true,
        installed: [{ skillName: 'demo', scope: 'user', source: 'opencode' }],
        skipped: [],
      });
      await expect(probe).resolves.toBeUndefined();
      expect(fs.existsSync(path.join(userSkillDir, 'demo', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(cloneDestination)).toBe(false);
    } finally {
      fallbackGate.resolve(ok());
      localGate.resolve(ok());
      blockerGate.resolve();
      await Promise.allSettled([blocker, install, ...(probe ? [probe] : [])]);
    }
  });

  it('propagates install authentication fallback failure and cleans the temporary destination', async () => {
    const root = createTempDir();
    const cloneArgs = [];
    let destination = '';
    runGitMock.mockImplementation((args) => {
      if (args[0] !== 'clone') return ok();
      cloneArgs.push(args);
      destination = args.at(-1);
      tempPaths.push(destination);
      if (cloneArgs.length === 1) {
        return { ok: false, stdout: '', stderr: 'partial clone unsupported', message: '' };
      }
      return { ok: false, stdout: '', stderr: 'Permission denied (publickey)', message: 'clone failed' };
    });

    await expect(installSkillsFromRepository({
      source: 'owner/repo',
      scope: 'user',
      targetSource: 'opencode',
      userSkillDir: path.join(root, 'user-skills'),
      selections: [{ skillDir: 'skills/demo' }],
      conflictPolicy: 'overwriteAll',
    })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'authRequired',
        message: 'Authentication required to access this repository',
        sshOnly: true,
      },
    });
    expect(cloneArgs).toHaveLength(2);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
