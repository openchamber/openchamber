import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  getGitStatus: mock(),
  getGitLog: mock(),
  getGitDiff: mock(),
};

const sdkClient = {
  model: {
    list: mock(),
  },
  experimental: {
    generate: {
      text: mock(),
    },
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

const { generateBridgeCommitMessage, resetBridgeGitModelCatalogForTest, setUnavailableRetryDelaysForTest } = await import('./bridge-git-special-runtime');

// The SCM title-bar command runs the same generator on the extension host; the
// bridge handler that once wrapped it is gone.
const generate = (options = {}) => generateBridgeCommitMessage({
  directory: '/repo',
  files: [],
  apiUrl: 'http://opencode.test',
  authHeaders: {},
  settings: {},
  promptOverrides: {},
  payloadModel: {},
  execGit: mock(),
  ...options,
});

describe('bridge git commit message generator', () => {
  beforeEach(() => {
    resetBridgeGitModelCatalogForTest();
    gitService.getGitStatus.mockReset();
    gitService.getGitLog.mockReset();
    gitService.getGitDiff.mockReset();
    sdkClient.model.list.mockReset();
    sdkClient.experimental.generate.text.mockReset();
    sdkClient.agent.get.mockReset();
    make.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    make.mockImplementation(() => sdkClient);
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    sdkClient.model.list.mockImplementation(async () => ({
      location: { directory: '/repo', project: { id: 'p', directory: '/repo', canonical: '/repo' } },
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
    }));
    sdkClient.agent.get.mockImplementation(async () => {
      const error = new Error('agent not found');
      error.status = 404;
      throw error;
    });
  });

  it('generates a commit message for the changed files through the OpenCode generate route', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix(ui): earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const message = await generate();

    expect(message).toEqual({ subject: 'feat: add a line', highlights: ['adds a line'] });
    expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(1);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].prompt).toContain('+new line');
  });

  it('reads the prompts of the directory it commits in and uses an empty instructions override as written', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":[]}' }));
    const promptOverrides = {
      'git.commit.generate.visible': 'Project visible',
      'git.commit.generate.instructions': '',
    };

    const message = await generate({ promptOverrides });

    expect(message.subject).toBe('feat: add a line');
    const prompt = sdkClient.experimental.generate.text.mock.calls[0][0].prompt;
    expect(prompt.startsWith('Project visible\n\n\n\nDiffs of the selected files:')).toBe(true);
    expect(prompt).not.toContain('Return exactly one JSON object');
  });

  it('uses the title agent model and its thinking variant when no request or override model is set', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({
      data: { model: { providerID: 'sidecar', id: 'tiny-model', variant: 'low' } },
    }));
    sdkClient.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'sidecar', id: 'tiny-model', variants: [{ id: 'low' }] }],
    }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate();

    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({
      id: 'tiny-model',
      providerID: 'sidecar',
      variant: 'low',
    });
  });

  it('skips a title agent model OpenCode lists as disabled, like the server resolver', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({ data: { model: { providerID: 'sidecar', id: 'tiny-model' } } }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'sidecar', id: 'tiny-model', enabled: false }] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate();

    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'gpt-5-nano', providerID: 'zen' });
  });

  it('skips a saved free zen small model without a login, like the server resolver', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'opencode', id: 'big-pickle', enabled: true, settings: { apiKey: 'public' } }] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate({
      settings: { smallModelUseDefault: false, smallModelOverride: 'opencode/big-pickle' },
    });

    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'gpt-5-nano', providerID: 'zen' });
  });

  it('keeps the configured small model when the catalog is not readable yet', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => { throw new Error('cold catalog'); });
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const message = await generate({
      settings: { smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' },
    });

    expect(message.subject).toBe('feat: add a line');
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('carries the small-model thinking variant into generation', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5', variants: [{ id: 'high' }] }],
    }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate({
      settings: {
        smallModelUseDefault: false,
        smallModelOverride: 'anthropic/claude-sonnet-4-5',
        smallModelVariant: 'high',
      },
    });

    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({
      id: 'claude-sonnet-4-5',
      providerID: 'anthropic',
      variant: 'high',
    });
  });

  it('keeps the configured small model when the catalog comes back empty', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate({
      settings: { smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' },
    });

    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('keeps the configured small model when a partial catalog omits it', async () => {
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'other', id: 'some-model' }] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate({
      settings: { smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' },
    });

    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('scopes the catalog, agent, and generate reads to the flow directory', async () => {
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate({ directory: '/repo', authHeaders: { Authorization: 'Bearer test' }, payloadModel: {} });

    expect(make.mock.calls.length).toBeGreaterThan(0);
    expect(make.mock.calls.every((call) => call[0].headers['x-opencode-directory'] === encodeURIComponent('/repo'))).toBe(true);
  });

  it('reads the model catalog again when the flow directory changes', async () => {
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    await generate({ directory: '/repo' });
    await generate({ directory: '/other' });

    expect(sdkClient.model.list).toHaveBeenCalledTimes(2);
  });

  it('reports the failure when generation fails', async () => {
    sdkClient.experimental.generate.text.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    await expect(generate()).rejects.toThrow('model unavailable');
  });

  describe('while the model is still loading', () => {
    const unavailable = {
      _tag: 'ModelNotFoundError',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
      message: 'Model not found: anthropic/claude-sonnet-4-5',
    };
    const request = () => generate({ payloadModel: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' } });

    beforeEach(() => setUnavailableRetryDelaysForTest([1, 1]));

    it('retries with backoff until the model appears', async () => {
      let calls = 0;
      sdkClient.experimental.generate.text.mockImplementation(async () => {
        calls += 1;
        if (calls <= 2) throw unavailable;
        return { text: '{"subject":"feat: add a line","highlights":["adds a line"]}' };
      });

      const message = await request();

      expect(message.subject).toBe('feat: add a line');
      expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(3);
      setUnavailableRetryDelaysForTest();
    });

    it('gives up once the backoff runs out and never retries other errors', async () => {
      sdkClient.experimental.generate.text.mockImplementation(async () => { throw unavailable; });
      await expect(request()).rejects.toThrow();
      expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(3);

      sdkClient.experimental.generate.text.mockReset();
      sdkClient.experimental.generate.text.mockImplementation(async () => { throw { _tag: 'InvalidRequestError', message: 'Invalid prompt' }; });
      await expect(request()).rejects.toThrow();
      expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(1);
      setUnavailableRetryDelaysForTest();
    });
  });
});