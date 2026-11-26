import { beforeEach, describe, expect, mock, test } from 'bun:test';

const executeCommand = mock(async () => undefined);
const openExternal = mock(async () => true);
const showWarningMessage = mock(async () => undefined);
const updateWorkspaceFolders = mock(async (start, deleteCount, ...foldersToAdd) => {
  for (const folder of foldersToAdd) {
    currentWorkspaceFolders = [...currentWorkspaceFolders, { name: folder.uri.fsPath.split('/').pop(), uri: folder.uri }];
  }
  return true;
});
let currentWorkspaceFolders = [];

const activateQuotaGiftReset = mock(async () => undefined);

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

mock.module('vscode', () => ({
  commands: { executeCommand },
  env: { openExternal, uriScheme: 'cursor' },
  window: { showWarningMessage },
  l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) },
  workspace: {
    get workspaceFolders() {
      return currentWorkspaceFolders;
    },
    updateWorkspaceFolders,
  },
  Uri: {
    file: (fsPath) => ({ scheme: 'file', fsPath }),
    parse: (value, strict) => {
      const match = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(value);
      const scheme = match?.[2] ?? '';
      const authority = match?.[4] ?? '';
      const path = match?.[5] ?? '';
      if (strict && !scheme) {
        throw new Error(`Scheme is missing: ${value}`);
      }
      if (strict && !authority && path.startsWith('//')) {
        throw new Error(`Path cannot begin with // without authority: ${value}`);
      }
      const decoded = {
        authority: decodeURIComponent(authority),
        path: decodeURIComponent(path),
        query: decodeURIComponent(match?.[7] ?? ''),
        fragment: decodeURIComponent(match?.[9] ?? ''),
      };
      return {
        scheme,
        ...decoded,
        raw: value,
        strict,
        // Like vscode.Uri, toString(true) leaves the decoded components unescaped.
        toString: (skipEncoding) => (skipEncoding
          ? `${scheme}:${match?.[3] === undefined ? '' : `//${decoded.authority}`}${decoded.path}${decoded.query ? `?${decoded.query}` : ''}${decoded.fragment ? `#${decoded.fragment}` : ''}`
          : value),
      };
    },
  },
  Position,
  Range,
}));

mock.module('./opencodeConfig', () => ({
  readConfig: mock(() => ({})),
  readConfigLayers: mock(() => ({ userConfig: {}, projectConfig: {}, customConfig: {}, mergedConfig: {}, paths: {} })),
  removeProviderConfig: mock(),
  getProviderSources: mock(),
  getStoredProviderConfig: mock(),
  upsertProviderConfig: mock(),
}));
mock.module('./opencodeAuth', () => ({
  getProviderAuth: mock(),
  removeProviderAuth: mock(),
}));
mock.module('./quotaProviders', () => ({
  activateQuotaGiftReset,
  fetchQuotaForProvider: mock(),
  listConfiguredQuotaProviders: mock(),
}));
mock.module('./opencodeGoQuota', () => ({ fetchOpenCodeGoUsage: mock() }));
mock.module('./quotaCredentials', () => ({
  credentialStatus: mock(),
  deleteCredential: mock(),
  importCursorCredential: mock(),
  normalizeCredential: mock(),
  readCredential: mock(() => null),
  validateCredential: mock(),
  writeCredential: mock(),
}));
mock.module('./sessionActivityWatcher', () => ({ getSessionActivitySnapshot: mock() }));

const { handleSystemBridgeMessage } = await import('./bridge-system-runtime.ts');
const { openCodeTrust } = await import('./opencodeTrust.ts');

const deps = {
  resolveUserPath: (value) => value,
  fetchModelsMetadata: async () => ({}),
  updateCheckUrl: 'https://example.com/update-check',
  clientReloadDelayMs: 800,
};

describe('VS Code system bridge editor:openFile', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    updateWorkspaceFolders.mockClear();
    currentWorkspaceFolders = [];
  });

  test('uses vscode.open so VS Code can select the notebook editor', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'open-notebook',
      type: 'editor:openFile',
      payload: { path: '/workspace/notebook.ipynb' },
    }, undefined, deps);

    expect(response).toEqual({ id: 'open-notebook', type: 'editor:openFile', success: true });
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      { scheme: 'file', fsPath: '/workspace/notebook.ipynb' },
      {},
    );
  });

  test('preserves line and column selection for regular files', async () => {
    await handleSystemBridgeMessage({
      id: 'open-text',
      type: 'editor:openFile',
      payload: { path: '/workspace/source.ts', line: 4, column: 7 },
    }, undefined, deps);

    const position = new Position(3, 7);
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      { scheme: 'file', fsPath: '/workspace/source.ts' },
      { selection: new Range(position, position) },
    );
  });
});

describe('VS Code system bridge api:workspace:addFolder', () => {
  beforeEach(() => {
    updateWorkspaceFolders.mockClear();
    currentWorkspaceFolders = [];
  });

  test('refuses untrusted OpenCode configuration before changing workspace folders', async () => {
    const original = openCodeTrust.assess;
    openCodeTrust.assess = async () => ({ trusted: false });
    try {
      const response = await handleSystemBridgeMessage({
        id: 'untrusted-folder', type: 'api:workspace:addFolder', payload: { path: '/untrusted/project' },
      }, undefined, deps);
      expect(response.success).toBe(false);
      expect(updateWorkspaceFolders).not.toHaveBeenCalled();
    } finally { openCodeTrust.assess = original; }
  });

  test('adds a folder to the workspace and returns the folder list', async () => {
    currentWorkspaceFolders = [{ name: 'project-one', uri: { fsPath: '/workspace/project-one' } }];

    const response = await handleSystemBridgeMessage({
      id: 'add-folder',
      type: 'api:workspace:addFolder',
      payload: { path: '/home/user/my-project' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'add-folder',
      type: 'api:workspace:addFolder',
      success: true,
      data: {
        workspaceFolders: [
          { name: 'my-project', path: '/home/user/my-project' },
          { name: 'project-one', path: '/workspace/project-one' },
        ],
      },
    });
    expect(updateWorkspaceFolders).toHaveBeenCalledWith(
      1,
      null,
      { uri: { scheme: 'file', fsPath: '/home/user/my-project' } },
    );
  });

  test('does not duplicate an already-open workspace folder', async () => {
    currentWorkspaceFolders = [{ name: 'project-one', uri: { fsPath: '/workspace/project-one' } }];

    const response = await handleSystemBridgeMessage({
      id: 'add-existing',
      type: 'api:workspace:addFolder',
      payload: { path: '/workspace/project-one' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'add-existing',
      type: 'api:workspace:addFolder',
      success: true,
      data: {
        workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
      },
    });
    expect(updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  test('returns an error when VS Code rejects the folder add', async () => {
    updateWorkspaceFolders.mockResolvedValue(false);

    const response = await handleSystemBridgeMessage({
      id: 'add-rejected',
      type: 'api:workspace:addFolder',
      payload: { path: '/home/user/other' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'add-rejected',
      type: 'api:workspace:addFolder',
      success: false,
      error: 'Failed to add workspace folder',
    });
  });

  test('dedupes an already-open folder with a lowercase Windows drive letter', async () => {
    // VS Code reports workspace folder paths with lowercase drive letters
    // (d:\...), while the bridge normalizes the incoming path to uppercase
    // (D:\...). The comparison must normalize both sides.
    currentWorkspaceFolders = [{ name: 'project-one', uri: { fsPath: 'd:\\work\\project-one' } }];

    const response = await handleSystemBridgeMessage({
      id: 'add-win-dedupe',
      type: 'api:workspace:addFolder',
      payload: { path: 'D:\\work\\project-one' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'add-win-dedupe',
      type: 'api:workspace:addFolder',
      success: true,
      data: {
        workspaceFolders: [{ name: 'project-one', path: 'D:\\work\\project-one' }],
      },
    });
    expect(updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  test('rejects a missing path', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'add-missing',
      type: 'api:workspace:addFolder',
      payload: {},
    }, undefined, deps);

    expect(response).toEqual({
      id: 'add-missing',
      type: 'api:workspace:addFolder',
      success: false,
      error: 'Directory path is required',
    });
    expect(updateWorkspaceFolders).not.toHaveBeenCalled();
  });
});

describe('VS Code system bridge api:quota:giftReset:use', () => {
  beforeEach(() => {
    activateQuotaGiftReset.mockClear();
    activateQuotaGiftReset.mockResolvedValue(undefined);
  });

  test('activates a gift reset through the quota provider', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'gift-use',
      type: 'api:quota:giftReset:use',
      payload: { providerId: 'zai-coding-plan', recordId: 462029, resetType: 'FIVE_HOUR', grantType: 'GLOBAL' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'gift-use',
      type: 'api:quota:giftReset:use',
      success: true,
      data: { success: true },
    });
    expect(activateQuotaGiftReset).toHaveBeenCalledWith('zai-coding-plan', {
      recordId: 462029,
      resetType: 'FIVE_HOUR',
      grantType: 'GLOBAL',
    });
  });

  test('passes the record grantType through unchanged', async () => {
    await handleSystemBridgeMessage({
      id: 'gift-activity',
      type: 'api:quota:giftReset:use',
      payload: { providerId: 'zai-coding-plan', recordId: 1, resetType: 'WEEK', grantType: 'ACTIVITY' },
    }, undefined, deps);

    expect(activateQuotaGiftReset).toHaveBeenCalledWith('zai-coding-plan', {
      recordId: 1,
      resetType: 'WEEK',
      grantType: 'ACTIVITY',
    });
  });

  test('keeps an omitted grantType omitted', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'gift-no-grant',
      type: 'api:quota:giftReset:use',
      payload: { providerId: 'zai-coding-plan', recordId: 1, resetType: 'FIVE_HOUR' },
    }, undefined, deps);

    expect(response.success).toBe(true);
    expect(activateQuotaGiftReset).toHaveBeenCalledWith('zai-coding-plan', {
      recordId: 1,
      resetType: 'FIVE_HOUR',
      grantType: undefined,
    });
  });

  test.each([[''], ['   '], [null], [7]])('leaves grantType %j for the provider to reject', async (grantType) => {
    activateQuotaGiftReset.mockRejectedValueOnce(new Error('Invalid gift reset request'));

    const response = await handleSystemBridgeMessage({
      id: 'gift-bad-grant',
      type: 'api:quota:giftReset:use',
      payload: { providerId: 'zai-coding-plan', recordId: 1, resetType: 'FIVE_HOUR', grantType },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'gift-bad-grant',
      type: 'api:quota:giftReset:use',
      success: false,
      error: 'Invalid gift reset request',
    });
    expect(activateQuotaGiftReset).toHaveBeenCalledWith('zai-coding-plan', { recordId: 1, resetType: 'FIVE_HOUR', grantType });
  });

  test('rejects a payload without a recordId', async () => {
    const response = await handleSystemBridgeMessage({
      id: 'gift-missing',
      type: 'api:quota:giftReset:use',
      payload: { providerId: 'zai-coding-plan', resetType: 'FIVE_HOUR' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'gift-missing',
      type: 'api:quota:giftReset:use',
      success: false,
      error: 'Invalid gift reset request',
    });
    expect(activateQuotaGiftReset).not.toHaveBeenCalled();
  });

  test('returns the provider failure as a bridge error', async () => {
    activateQuotaGiftReset.mockRejectedValue(new Error('API error: 429'));

    const response = await handleSystemBridgeMessage({
      id: 'gift-failed',
      type: 'api:quota:giftReset:use',
      payload: { providerId: 'zai-coding-plan', recordId: 1, resetType: 'WEEK' },
    }, undefined, deps);

    expect(response).toEqual({
      id: 'gift-failed',
      type: 'api:quota:giftReset:use',
      success: false,
      error: 'API error: 429',
    });
  });
});

describe('VS Code v2 migration bridge', () => {
  test('waits for the manager to finish installing and restarting', async () => {
    let completed = false;
    const manager = { installV2: async () => { completed = true; } };
    const response = await handleSystemBridgeMessage({ id: 'install', type: 'api:opencode/install-v2' }, { manager }, deps);
    expect(completed).toBe(true);
    expect(response).toEqual({ id: 'install', type: 'api:opencode/install-v2', success: true, data: { success: true } });
  });

  test('does not claim success without a manager or after installation failure', async () => {
    const response = await handleSystemBridgeMessage({ id: 'missing', type: 'api:opencode/install-v2' }, undefined, deps);
    expect(response.success).toBe(false);
    const manager = { installV2: async () => { throw new Error('Installation failed'); } };
    await expect(handleSystemBridgeMessage({ id: 'failed', type: 'api:opencode/install-v2' }, { manager }, deps)).rejects.toThrow('Installation failed');
  });
});

describe('VS Code system bridge api:sessions/metadata:set', () => {
  const manager = { getApiUrl: () => 'http://127.0.0.1:9', getOpenCodeAuthHeaders: () => ({}) };
  const failingWith = (error) => ({ ...deps, sessionState: { setMetadata: async () => { throw error; } } });
  const message = { id: 'meta', type: 'api:sessions/metadata:set', payload: { sessionId: 'ses_a', patch: { openchamber: { work: { state: 'done' } } } } };

  test('reports a failed write', async () => {
    const response = await handleSystemBridgeMessage(message, { manager }, failingWith(new Error('OpenCode is down')));

    expect(response).toEqual({ id: 'meta', type: 'api:sessions/metadata:set', success: false, error: 'OpenCode is down' });
  });
});

describe('VS Code system bridge vscode:command allowlist', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    executeCommand.mockResolvedValue('ok');
  });

  test('refuses arbitrary, internal, and panel-only commands without executing them', async () => {
    for (const command of [
      'workbench.action.terminal.sendSequence',
      'vscode.openFolder',
      'openchamber.settingsReady',
      'openchamber.updateSessionEditorTitle',
      'openchamber.internal.showNotification',
      ' openchamber.showSettings ',
    ]) {
      const response = await handleSystemBridgeMessage({
        id: `deny-${command}`,
        type: 'vscode:command',
        payload: { command, args: [{ text: 'id\n' }] },
      }, undefined, deps);

      expect(response).toEqual({
        id: `deny-${command}`,
        type: 'vscode:command',
        success: false,
        error: `Command is not allowed: ${command}`,
      });
    }
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test('refuses missing, blank, or non-string command payloads', async () => {
    for (const payload of [undefined, null, {}, { command: '' }, { command: '   ' }, { command: 42 }]) {
      const response = await handleSystemBridgeMessage({
        id: 'missing-cmd',
        type: 'vscode:command',
        payload,
      }, undefined, deps);

      expect(response).toEqual({
        id: 'missing-cmd',
        type: 'vscode:command',
        success: false,
        error: 'Command is required',
      });
    }
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test('refuses malformed arguments for every allowed command', async () => {
    const malformedCases = [
      { command: 'openchamber.showSettings', args: [false] },
      { command: 'openchamber.showSettings', args: [''] },
      { command: 'openchamber.showSettings', args: [{}] },
      { command: 'openchamber.showSettings', args: [{ page: 42 }] },
      { command: 'openchamber.showSettings', args: [{ page: '' }] },
      { command: 'openchamber.showSettings', args: [{ page: 'appearance' }, 'extra'] },
      { command: 'openchamber.showSettings', args: 'not-an-array' },
      { command: 'openchamber.closeSettings', args: ['extra'] },
      { command: 'openchamber.closeSettings', args: [null] },
      { command: 'openchamber.closeSettings', args: null },
      { command: 'openchamber.setActiveSession', args: [123] },
      { command: 'openchamber.setActiveSession', args: [''] },
      { command: 'openchamber.setActiveSession', args: ['   '] },
      { command: 'openchamber.setActiveSession', args: ['ses_1', 42] },
      { command: 'openchamber.setActiveSession', args: ['ses_1', 'Title', 'extra'] },
      { command: 'openchamber.openSessionInEditor' },
      { command: 'openchamber.openSessionInEditor', args: [] },
      { command: 'openchamber.openSessionInEditor', args: [null] },
      { command: 'openchamber.openSessionInEditor', args: [''] },
      { command: 'openchamber.openSessionInEditor', args: [123] },
      { command: 'openchamber.openSessionInEditor', args: ['ses_1', 42] },
      { command: 'openchamber.openSessionInEditor', args: ['ses_1', 'Title', 'extra'] },
      { command: 'openchamber.internal.openSession' },
      { command: 'openchamber.internal.openSession', args: [] },
      { command: 'openchamber.internal.openSession', args: [null] },
      { command: 'openchamber.internal.openSession', args: [''] },
      { command: 'openchamber.internal.openSession', args: ['   '] },
      { command: 'openchamber.internal.openSession', args: [123] },
      { command: 'openchamber.internal.openSession', args: ['ses_1', 'extra'] },
    ];

    for (const payload of malformedCases) {
      const response = await handleSystemBridgeMessage({
        id: `bad-${payload.command}`,
        type: 'vscode:command',
        payload,
      }, undefined, deps);

      expect(response).toEqual({
        id: `bad-${payload.command}`,
        type: 'vscode:command',
        success: false,
        error: `Invalid arguments for command: ${payload.command}`,
      });
    }
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test('executes all 5 allowed commands with validated and sanitized arguments', async () => {
    const validCases = [
      {
        payload: { command: 'openchamber.showSettings' },
        expectedCall: ['openchamber.showSettings'],
      },
      {
        payload: { command: 'openchamber.showSettings', args: [] },
        expectedCall: ['openchamber.showSettings'],
      },
      {
        payload: { command: 'openchamber.showSettings', args: [null] },
        expectedCall: ['openchamber.showSettings'],
      },
      {
        payload: { command: 'openchamber.showSettings', args: [undefined] },
        expectedCall: ['openchamber.showSettings'],
      },
      {
        payload: {
          command: 'openchamber.showSettings',
          args: [{ page: ' mcp ', itemId: 'mcp.create', directory: '/work/repo', connectProvider: false, providerId: null, ignored: 'strip-me' }],
        },
        expectedCall: ['openchamber.showSettings', { page: 'mcp', itemId: 'mcp.create', directory: '/work/repo', connectProvider: false, providerId: null }],
      },
      {
        payload: { command: 'openchamber.closeSettings' },
        expectedCall: ['openchamber.closeSettings'],
      },
      {
        payload: { command: 'openchamber.closeSettings', args: [] },
        expectedCall: ['openchamber.closeSettings'],
      },
      {
        payload: { command: 'openchamber.setActiveSession', args: [null, null] },
        expectedCall: ['openchamber.setActiveSession', null, null],
      },
      {
        payload: { command: 'openchamber.setActiveSession', args: [' ses_abc ', 'Session Title'] },
        expectedCall: ['openchamber.setActiveSession', 'ses_abc', 'Session Title'],
      },
      {
        payload: { command: 'openchamber.setActiveSession', args: ['ses_abc', 'x'.repeat(5000)] },
        expectedCall: ['openchamber.setActiveSession', 'ses_abc', 'x'.repeat(4096)],
      },
      {
        payload: { command: 'openchamber.setActiveSession', args: ['ses_abc'] },
        expectedCall: ['openchamber.setActiveSession', 'ses_abc'],
      },
      {
        payload: { command: 'openchamber.setActiveSession', args: [] },
        expectedCall: ['openchamber.setActiveSession'],
      },
      {
        payload: { command: 'openchamber.openSessionInEditor', args: ['ses_abc'] },
        expectedCall: ['openchamber.openSessionInEditor', 'ses_abc'],
      },
      {
        payload: { command: 'openchamber.openSessionInEditor', args: [' ses_abc ', 'My Session'] },
        expectedCall: ['openchamber.openSessionInEditor', 'ses_abc', 'My Session'],
      },
      {
        payload: { command: 'openchamber.openSessionInEditor', args: ['ses_abc', null] },
        expectedCall: ['openchamber.openSessionInEditor', 'ses_abc'],
      },
      {
        payload: { command: 'openchamber.internal.openSession', args: ['ses_abc'] },
        expectedCall: ['openchamber.internal.openSession', 'ses_abc'],
      },
      {
        payload: { command: 'openchamber.internal.openSession', args: [' ses_abc '] },
        expectedCall: ['openchamber.internal.openSession', 'ses_abc'],
      },
    ];

    for (const { payload, expectedCall } of validCases) {
      executeCommand.mockClear();
      const response = await handleSystemBridgeMessage({
        id: `ok-${payload.command}`,
        type: 'vscode:command',
        payload,
      }, undefined, deps);

      expect(response).toEqual({
        id: `ok-${payload.command}`,
        type: 'vscode:command',
        success: true,
        data: { result: 'ok' },
      });
      expect(executeCommand).toHaveBeenCalledWith(...expectedCall);
    }
  });
});

describe('VS Code system bridge vscode:openExternalUrl', () => {
  beforeEach(() => {
    openExternal.mockClear();
    openExternal.mockResolvedValue(true);
    showWarningMessage.mockReset();
    showWarningMessage.mockResolvedValue(undefined);
  });

  const openUrl = (url) => handleSystemBridgeMessage({
    id: 'open-url',
    type: 'vscode:openExternalUrl',
    payload: { url },
  }, undefined, deps);

  test('opens http and https links directly, without asking', async () => {
    for (const url of ['https://example.test/docs?a=1', 'http://localhost:3901/', 'HTTPS://Example.test/a']) {
      openExternal.mockClear();
      const response = await openUrl(url);
      expect(response).toEqual({ id: 'open-url', type: 'vscode:openExternalUrl', success: true, data: { opened: true } });
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal.mock.calls[0][0]).toMatchObject({ scheme: url.split(':')[0].toLowerCase(), strict: true });
    }
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  test('opens a link to another app after the user confirms it in a modal naming the scheme and the URL', async () => {
    showWarningMessage.mockResolvedValue('Open');
    for (const url of ['zed://file/Users/dev/a.ts', 'figma://file/abc', 'slack://open?team=T1', 'obsidian://open?vault=Notes&file=a%20b']) {
      openExternal.mockClear();
      showWarningMessage.mockClear();
      const response = await openUrl(url);
      expect(response).toEqual({ id: 'open-url', type: 'vscode:openExternalUrl', success: true, data: { opened: true } });
      const scheme = url.split(':')[0];
      expect(showWarningMessage).toHaveBeenCalledTimes(1);
      const [message, options, ...items] = showWarningMessage.mock.calls[0];
      expect(message).toBe('Open this link in another app?');
      expect(options.modal).toBe(true);
      expect(options.detail).toContain(`${scheme}://`);
      expect(options.detail).toContain(url);
      expect(items).toEqual(['Open']);
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal.mock.calls[0][0]).toMatchObject({ scheme, raw: url, strict: true });
    }
  });

  test('shows in the modal the URL VS Code hands the app, with escaped delimiters decoded', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    await openUrl('obsidian://open?vault=Notes&file=A%26B');
    const [, options] = showWarningMessage.mock.calls[0];
    expect(options.detail).toContain('obsidian://open?vault=Notes&file=A&B');
    expect(options.detail).not.toContain('A%26B');
  });

  test('does not open a link to another app when the user cancels the modal', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const response = await openUrl('zed://file/Users/dev/a.ts');
    expect(response).toEqual({ id: 'open-url', type: 'vscode:openExternalUrl', success: true, data: { opened: false } });
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test('refuses dangerous schemes, the editor\'s own schemes, mail and malformed URLs without asking or opening', async () => {
    const refused = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'command:workbench.action.terminal.new',
      'vscode://vscode.git/clone?url=https://evil.test',
      'VSCODE-INSIDERS://file/a',
      'cursor://anysphere.cursor-retrieval/x',
      'vscode-remote://ssh-remote+evil/tmp',
      'vscode-file://vscode-app/etc/passwd',
      'ms-msdt:id%20PCWDiagnostic',
      'search-ms:query=report',
      'shell:AppsFolder',
      'openchamber://connect?host=x',
      'mailto:support@example.test',
      'tel:+1234567890',
      'a://short',
      'http:example.test',
      'https://example.test/a\r\nb',
      'not a url',
      '',
      '   ',
    ];
    for (const url of refused) {
      const response = await openUrl(url);
      expect(response.success).toBe(false);
    }
    for (const payload of [undefined, null, {}, { url: 123 }]) {
      const response = await handleSystemBridgeMessage({ id: 'missing-url', type: 'vscode:openExternalUrl', payload }, undefined, deps);
      expect(response).toEqual({ id: 'missing-url', type: 'vscode:openExternalUrl', success: false, error: 'URL is required' });
    }
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
