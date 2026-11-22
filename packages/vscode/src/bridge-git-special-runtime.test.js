import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
  getGitStatus: mock(),
  getGitLog: mock(),
  getGitDiff: mock(),
};

const sdkClient = {
  model: {
    list: mock(),
  },
  generate: {
    text: mock(),
  },
  agent: {
    get: mock(),
  },
};

const make = mock(() => sdkClient);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

mock.module('./gitService', () => gitService);
mock.module('@opencode/client', () => ({ OpenCode: { make } }));

const { handleSpecialGitBridgeMessage, resetBridgeGitModelCatalogForTest, setUnavailableRetryDelaysForTest } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  beforeEach(() => {
    resetBridgeGitModelCatalogForTest();
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    sdkClient.model.list.mockReset();
    sdkClient.generate.text.mockReset();
    sdkClient.agent.get.mockReset();
    make.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    make.mockImplementation(() => sdkClient);
    gitService.getGitRangeFiles.mockImplementation(async () => ['src/a.ts']);
    gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' }));
    sdkClient.model.list.mockImplementation(async () => ({
      location: { directory: '/repo', project: { id: 'p', directory: '/repo', canonical: '/repo' } },
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
    }));
    sdkClient.generate.text.mockImplementation(async () => ({
      text: '{"title":"PR title","body":"PR body"}',
    }));
    // A location with no configured title agent answers 404, the same shape
    // the server's small-model client treats as "nothing configured".
    sdkClient.agent.get.mockImplementation(async () => {
      const error = new Error('agent not found');
      error.status = 404;
      throw error;
    });
  });

  it('generates a commit message for the changed files through the OpenCode generate route', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix(ui): earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'c1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response).toEqual({
      id: 'c1',
      type: 'api:git/commit-message',
      success: true,
      data: { message: { subject: 'feat: add a line', highlights: ['adds a line'] } },
    });
    expect(sdkClient.generate.text).toHaveBeenCalledTimes(1);
    expect(sdkClient.generate.text.mock.calls[0][0].prompt).toContain('+new line');
  });

  it('generates PR descriptions through the OpenCode generate route', async () => {
    const response = await handleSpecialGitBridgeMessage({
      id: '1',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });
    expect(rawFetch).not.toHaveBeenCalled();
    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test', 'x-opencode-directory': encodeURIComponent('/repo') },
    });
    expect(sdkClient.model.list).toHaveBeenCalled();
    expect(sdkClient.generate.text).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('uses the title agent model when no request or override model is set', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({ data: { model: { providerID: 'sidecar', id: 'tiny-model' } } }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'sidecar', id: 'tiny-model' }] }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 't1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.generate.text.mock.calls[0][0].model).toEqual({ id: 'tiny-model', providerID: 'sidecar' });
  });

  it('skips a title agent model OpenCode lists as disabled, like the server resolver', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({ data: { model: { providerID: 'sidecar', id: 'tiny-model' } } }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'sidecar', id: 'tiny-model', enabled: false }] }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 't2',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.generate.text.mock.calls[0][0].model).toEqual({ id: 'gpt-5-nano', providerID: 'zen' });
  });

  it('keeps the configured small model when the catalog is not readable yet', async () => {
    // The first click of a cold start: OpenCode answers the model list before
    // the location's providers load, so the read fails. An unreadable catalog
    // is not an empty one — dropping the user's configured small model here
    // sent generation to the zen default the reporter cannot use.
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => { throw new Error('cold catalog'); });
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'cold1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('keeps the configured small model when the catalog comes back empty', async () => {
    // The other cold-start shape: the read succeeds but lists nothing yet.
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [] }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'cold2',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('keeps the configured small model when a partial catalog omits it', async () => {
    // A cold start can answer a non-empty list before every provider has
    // loaded. Only a model the catalog lists as disabled is rejected, the same
    // rule the server resolver applies.
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'other', id: 'some-model' }] }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'partial1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('scopes the catalog, agent, and generate reads to the flow directory', async () => {
    await handleSpecialGitBridgeMessage({
      id: 's1',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }) } }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(make.mock.calls.length).toBeGreaterThan(0);
    expect(make.mock.calls.every((call) => call[0].headers['x-opencode-directory'] === encodeURIComponent('/repo'))).toBe(true);
  });

  it('reads the model catalog again when the flow directory changes', async () => {
    const prFlow = (id, directory) => handleSpecialGitBridgeMessage({
      id,
      type: 'api:git/pr-description',
      payload: { directory, base: 'main', head: 'feature' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    await prFlow('c1', '/repo');
    await prFlow('c2', '/other');

    expect(sdkClient.model.list).toHaveBeenCalledTimes(2);
  });

  it('reports the failure instead of a half-written description when generation fails', async () => {
    sdkClient.generate.text.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    const response = await handleSpecialGitBridgeMessage({
      id: '2',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({ id: '2', type: 'api:git/pr-description', success: false, error: 'model unavailable' });
  });

  describe('while the model is still loading', () => {
    const unavailable = { _tag: 'InvalidRequestError', message: 'Model unavailable: anthropic/claude-sonnet-4-5' };
    const request = () => handleSpecialGitBridgeMessage({
      id: '3',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature', providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    }, {
      manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) },
    }, { readSettings: () => ({}), execGit: mock() });

    beforeEach(() => setUnavailableRetryDelaysForTest([1, 1]));

    it('retries with backoff until the model appears', async () => {
      let calls = 0;
      sdkClient.generate.text.mockImplementation(async () => {
        calls += 1;
        if (calls <= 2) throw unavailable;
        return { text: '{"title":"PR title","body":"PR body"}' };
      });

      const response = await request();

      expect(response.success).toBe(true);
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(3);
      setUnavailableRetryDelaysForTest();
    });

    it('gives up once the backoff runs out and never retries other errors', async () => {
      sdkClient.generate.text.mockImplementation(async () => { throw unavailable; });
      expect((await request()).success).toBe(false);
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(3);

      sdkClient.generate.text.mockReset();
      sdkClient.generate.text.mockImplementation(async () => { throw { _tag: 'InvalidRequestError', message: 'Invalid prompt' }; });
      await request();
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(1);
      setUnavailableRetryDelaysForTest();
    });
  });
});

// Real-git helpers for the conflict-details tests: the MERGE_MSG bug only
// exists against a real on-disk git layout, so these tests use real repos
// (including a real linked worktree) and a real execGit instead of mocks.
const execGitReal = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd }, (error, stdout, stderr) => {
    resolve({
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      exitCode: error ? 1 : 0,
    });
  });
});

const runGitSync = (cwd, args, allowFail = false) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (!allowFail) throw error;
    return String(error.stdout || '');
  }
};

const initTempRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-conflict-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n');
  runGitSync(dir, ['add', '.']);
  runGitSync(dir, ['commit', '-m', 'init']);
  return dir;
};

const makeMergeConflict = (dir, baseBranch) => {
  runGitSync(dir, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n');
  runGitSync(dir, ['commit', '-am', 'feature']);
  runGitSync(dir, ['checkout', baseBranch]);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'main\n');
  runGitSync(dir, ['commit', '-am', 'main change']);
  runGitSync(dir, ['merge', 'feature'], true);
};

const callConflictDetails = (directory, execGit = execGitReal) => handleSpecialGitBridgeMessage({
  id: 'cd1',
  type: 'api:git/conflict-details',
  payload: { directory },
}, undefined, {
  readSettings: () => ({}),
  execGit,
  readPromptOverrides: () => ({}),
});

describe('bridge git conflict-details MERGE_MSG resolution', () => {
  it('includes the merge message in a main worktree', async () => {
    const dir = initTempRepo();
    try {
      makeMergeConflict(dir, 'main');
      const response = await callConflictDetails(dir);
      expect(response.success).toBe(true);
      expect(response.data.operation).toBe('merge');
      expect(response.data.headInfo).toContain("Merge branch 'feature'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('includes the merge message in a linked worktree', async () => {
    const baseDir = initTempRepo();
    const wtDir = path.join(os.tmpdir(), `bridge-conflict-linked-${Date.now()}`);
    try {
      runGitSync(baseDir, ['worktree', 'add', '-b', 'wtbranch', wtDir, 'main']);
      runGitSync(wtDir, ['config', 'user.email', 'test@example.com']);
      runGitSync(wtDir, ['config', 'user.name', 'Test']);
      // `.git` in a linked worktree is a file, not a directory: this is the
      // layout the old path.join(directory, '.git', 'MERGE_MSG') read missed.
      expect(fs.statSync(path.join(wtDir, '.git')).isFile()).toBe(true);
      makeMergeConflict(wtDir, 'wtbranch');
      const response = await callConflictDetails(wtDir);
      expect(response.success).toBe(true);
      expect(response.data.operation).toBe('merge');
      expect(response.data.unmergedFiles).toEqual(['file.txt']);
      expect(response.data.headInfo).toContain("Merge branch 'feature'");
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  }, 20000);

  it('degrades to the bare MERGE_HEAD line when MERGE_MSG is genuinely absent', async () => {
    const dir = initTempRepo();
    try {
      makeMergeConflict(dir, 'main');
      const mergeMsgPath = path.resolve(dir, runGitSync(dir, ['rev-parse', '--git-path', 'MERGE_MSG']).trim());
      fs.rmSync(mergeMsgPath, { force: true });
      const mergeHead = runGitSync(dir, ['rev-parse', 'MERGE_HEAD']).trim();
      const response = await callConflictDetails(dir);
      expect(response.success).toBe(true);
      expect(response.data.headInfo).toBe(`MERGE_HEAD: ${mergeHead}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('answers an idle repository with no operation in progress as a success', async () => {
    const dir = initTempRepo();
    try {
      const response = await callConflictDetails(dir);
      expect(response.success).toBe(true);
      expect(response.data).toEqual({
        statusPorcelain: '',
        unmergedFiles: [],
        diff: '',
        headInfo: '',
        operation: 'merge',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('bridge git conflict-details git read failures', () => {
  it('rejects a directory that is not a git repository instead of reporting an empty merge', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-conflict-nonrepo-'));
    try {
      const response = await callConflictDetails(dir);
      expect(response.success).toBe(false);
      expect(response.error).toContain('not a git repository');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('rejects a failing status read and surfaces the git error', async () => {
    const execGit = mock(async () => ({
      stdout: '',
      stderr: 'fatal: index file smaller than expected',
      exitCode: 128,
    }));
    const response = await callConflictDetails('/repo', execGit);
    expect(response.success).toBe(false);
    expect(response.error).toContain('git status --porcelain failed');
    expect(response.error).toContain('fatal: index file smaller than expected');
  });

  it('does not read a failed unmerged list as no conflicts', async () => {
    const execGit = mock(async (args) => {
      if (args.includes('--diff-filter=U')) {
        return { stdout: '', stderr: 'fatal: bad revision', exitCode: 128 };
      }
      return { stdout: args[0] === 'status' ? 'UU file.txt\n' : '', stderr: '', exitCode: 0 };
    });
    const response = await callConflictDetails('/repo', execGit);
    expect(response.success).toBe(false);
    expect(response.error).toContain('git diff --name-only --diff-filter=U failed');
  });

  it('does not read a failed diff as an empty diff', async () => {
    const execGit = mock(async (args) => {
      if (args.length === 1 && args[0] === 'diff') {
        return { stdout: '', stderr: 'fatal: unable to read tree', exitCode: 128 };
      }
      return { stdout: args[0] === 'status' ? 'UU file.txt\n' : 'file.txt\n', stderr: '', exitCode: 0 };
    });
    const response = await callConflictDetails('/repo', execGit);
    expect(response.success).toBe(false);
    expect(response.error).toContain('git diff failed');
  });
});
