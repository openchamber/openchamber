import { beforeEach, describe, expect, mock, test } from 'bun:test';

const executeCommand = mock(async () => undefined);

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
    workspaceFolders: [],
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
