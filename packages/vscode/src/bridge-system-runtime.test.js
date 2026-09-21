import { beforeEach, describe, expect, mock, test } from 'bun:test';

const executeCommand = mock(async () => undefined);
const updateWorkspaceFolders = mock(async (start, deleteCount, ...foldersToAdd) => {
  for (const folder of foldersToAdd) {
    currentWorkspaceFolders = [...currentWorkspaceFolders, { name: folder.uri.fsPath.split('/').pop(), uri: folder.uri }];
  }
  return true;
});
let currentWorkspaceFolders = [];

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
  workspace: {
    get workspaceFolders() {
      return currentWorkspaceFolders;
    },
    updateWorkspaceFolders,
  },
  Uri: {
    file: (fsPath) => ({ scheme: 'file', fsPath }),
  },
  Position,
  Range,
}));

mock.module('./opencodeConfig', () => ({
  removeProviderConfig: mock(),
  getProviderSources: mock(),
  upsertProviderConfig: mock(),
}));
mock.module('./opencodeAuth', () => ({
  getProviderAuth: mock(),
  removeProviderAuth: mock(),
}));
mock.module('./quotaProviders', () => ({
  fetchQuotaForProvider: mock(),
  listConfiguredQuotaProviders: mock(),
}));
mock.module('./opencodeGoQuota', () => ({ fetchOpenCodeGoUsage: mock() }));
mock.module('./quotaCredentials', () => ({
  credentialStatus: mock(),
  deleteCredential: mock(),
  importCursorCredential: mock(),
  normalizeCredential: mock(),
  readCredential: mock(),
  validateCredential: mock(),
  writeCredential: mock(),
}));
mock.module('./sessionActivityWatcher', () => ({ getSessionActivitySnapshot: mock() }));

const { handleSystemBridgeMessage } = await import('./bridge-system-runtime.ts');

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
