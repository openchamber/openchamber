import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  stageGitFiles: mock(),
  unstageGitFiles: mock(),
  checkoutCommit: mock(),
  cherryPick: mock(),
  revertCommit: mock(),
  resetToCommit: mock(),
};

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
  workspace: { fs: { readFile: async () => new Uint8Array() } },
}));

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');
const {
  GitExecutionOverloadedError,
  GitExecutionQueueTimeoutError,
} = await import('./git-execution-errors');

const agentManagerProviderUrl = new URL('./AgentManagerPanelProvider.ts', import.meta.url).href;
const gitExecutionErrorsUrl = new URL('./git-execution-errors.ts', import.meta.url).href;

const productionBridgeProbe = `
  import { mock } from 'bun:test';

  let receiveMessage;
  const posted = [];
  const createUri = (fsPath) => ({
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => 'file://' + fsPath,
  });
  const webview = {
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (value) => value,
    postMessage: async (response) => {
      posted.push(response);
      return true;
    },
    onDidReceiveMessage: (handler) => {
      receiveMessage = handler;
      return { dispose() {} };
    },
  };
  const panel = {
    webview,
    onDidDispose: () => ({ dispose() {} }),
    reveal() {},
  };

  mock.module('vscode', () => ({
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ViewColumn: { One: 1, Active: -1, Beside: 2 },
    commands: { executeCommand: async () => undefined },
    extensions: { getExtension: () => undefined, all: [] },
    l10n: { t: (value) => value },
    Uri: {
      file: createUri,
      joinPath: (base, ...parts) => createUri([base.fsPath, ...parts].join('/')),
    },
    window: {
      activeColorTheme: { kind: 2 },
      createWebviewPanel: () => panel,
      state: { focused: true },
    },
    workspace: {
      fs: { readFile: async () => new Uint8Array() },
      getConfiguration: () => ({ get: () => undefined }),
      workspaceFolders: [],
    },
  }));

  const { AgentManagerPanelProvider } = await import(${JSON.stringify(agentManagerProviderUrl)});
  const {
    GitExecutionCancelledError,
    GitExecutionOverloadedError,
    GitExecutionQueueTimeoutError,
  } = await import(${JSON.stringify(gitExecutionErrorsUrl)});

  const provider = new AgentManagerPanelProvider({
    extensionMode: 1,
    subscriptions: [],
    extension: { packageJSON: { version: 'test' } },
  }, createUri('/extension'));
  provider.createOrShow();
  if (!receiveMessage) {
    throw new Error('Production bridge listener was not registered');
  }

  const dispatch = async (message) => {
    await receiveMessage(message);
    return posted.filter((response) => response?.id === message.id);
  };
  const throwingPayload = (error) => new Proxy({}, {
    get() {
      throw error;
    },
  });

  const overload = new GitExecutionOverloadedError('Git execution queue is full', {
    commonId: 'secret-common-id',
    lane: 'write',
  });
  const queueTimeout = new GitExecutionQueueTimeoutError('Git stage timed out while queued', {
    queueTimeoutMs: 25,
    worktreeId: 'secret-worktree-id',
  });
  const cancellation = new GitExecutionCancelledError('Git execution was cancelled', {
    commonId: 'secret-cancelled-common-id',
  });

  const results = {
    overload: await dispatch({
      id: 'structured-overload',
      type: 'api:git/stage',
      payload: throwingPayload(overload),
    }),
    queueTimeout: await dispatch({
      id: 'structured-queue-timeout',
      type: 'api:git/stage',
      payload: throwingPayload(queueTimeout),
    }),
    cancellation: await dispatch({
      id: 'structured-cancellation',
      type: 'api:git/stage',
      payload: throwingPayload(cancellation),
    }),
    success: await dispatch({
      id: 'normal-success',
      type: 'api:git/worktrees/bootstrap-status',
      payload: { directory: '/repo/worktree' },
    }),
  };
  console.log(JSON.stringify(results));
`;

const runProductionBridgeProbe = async () => {
  const child = Bun.spawn([process.execPath, '-e', productionBridgeProbe], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Production bridge probe failed (${exitCode}): ${stderr}`);
  }
  return JSON.parse(stdout.trim());
};

describe('bridge git runtime index mutations', () => {
  beforeEach(() => {
    gitService.stageGitFiles.mockReset();
    gitService.unstageGitFiles.mockReset();
    gitService.checkoutCommit.mockReset();
    gitService.cherryPick.mockReset();
    gitService.revertCommit.mockReset();
    gitService.resetToCommit.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', path: 'a.ts' },
    }, gitService);

    expect(response).toEqual({ id: '1', type: 'api:git/stage', success: true, data: { success: true } });
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    }, gitService);

    expect(response?.success).toBe(true);
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', path: 'a.ts' },
    }, gitService);

    expect(response).toEqual({ id: '1', type: 'api:git/unstage', success: true, data: { success: true } });
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    }, gitService);

    expect(response?.success).toBe(true);
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: [' ', null] },
    }, gitService);

    expect(response?.success).toBe(false);
    expect(gitService.stageGitFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['overload', new GitExecutionOverloadedError('Git execution queue is full')],
    ['queue timeout', new GitExecutionQueueTimeoutError('Git stage timed out while queued')],
  ])('preserves structured coordinator %s failures for the outer bridge error envelope', async (_label, error) => {
    gitService.stageGitFiles.mockImplementation(async () => {
      throw error;
    });

    const response = handleStandardGitBridgeMessage({
      id: 'structured',
      type: 'api:git/stage',
      payload: { directory: '/repo', path: 'a.ts' },
    }, gitService);

    await expect(response).rejects.toBe(error);
  });

  it('rejects invalid commit hashes before commit actions reach git service', async () => {
    const checkoutResponse = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/checkout-commit',
      payload: { directory: '/repo', hash: 'HEAD' },
    }, gitService);
    const cherryPickResponse = await handleStandardGitBridgeMessage({
      id: '2',
      type: 'api:git/cherry-pick',
      payload: { directory: '/repo', hash: '--abort' },
    }, gitService);
    const revertResponse = await handleStandardGitBridgeMessage({
      id: '3',
      type: 'api:git/revert-commit',
      payload: { directory: '/repo', hash: '--continue' },
    }, gitService);
    const resetResponse = await handleStandardGitBridgeMessage({
      id: '4',
      type: 'api:git/reset-to-commit',
      payload: { directory: '/repo', hash: '--hard', mode: 'mixed' },
    }, gitService);

    expect(checkoutResponse).toEqual({ id: '1', type: 'api:git/checkout-commit', success: false, error: 'Invalid commit hash' });
    expect(cherryPickResponse).toEqual({ id: '2', type: 'api:git/cherry-pick', success: false, error: 'Invalid commit hash' });
    expect(revertResponse).toEqual({ id: '3', type: 'api:git/revert-commit', success: false, error: 'Invalid commit hash' });
    expect(resetResponse).toEqual({ id: '4', type: 'api:git/reset-to-commit', success: false, error: 'Invalid commit hash' });
    expect(gitService.checkoutCommit).not.toHaveBeenCalled();
    expect(gitService.cherryPick).not.toHaveBeenCalled();
    expect(gitService.revertCommit).not.toHaveBeenCalled();
    expect(gitService.resetToCommit).not.toHaveBeenCalled();
  });
});

describe('production bridge Git dispatch', () => {
  it('posts one redacted response for structured failures and one normal success response', async () => {
    const results = await runProductionBridgeProbe();

    expect(results.overload).toEqual([{
      id: 'structured-overload',
      type: 'api:git/stage',
      success: false,
      error: 'Git execution queue is full',
    }]);
    expect(results.queueTimeout).toEqual([{
      id: 'structured-queue-timeout',
      type: 'api:git/stage',
      success: false,
      error: 'Git stage timed out while queued',
    }]);
    expect(results.cancellation).toEqual([{
      id: 'structured-cancellation',
      type: 'api:git/stage',
      success: false,
      error: 'Git execution was cancelled',
    }]);
    expect(results.success).toEqual([{
      id: 'normal-success',
      type: 'api:git/worktrees/bootstrap-status',
      success: true,
      data: {
        status: 'ready',
        error: null,
        updatedAt: expect.any(Number),
      },
    }]);

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('GIT_EXECUTION_');
    expect(serialized).not.toContain('secret-');
    expect(serialized).not.toContain('stack');
  });
});
