import { afterEach, describe, expect, test } from 'bun:test';
import { getVSCodeBootstrapConfig, isVSCodeBootstrapPresent } from './vscodeBootstrap';

describe('VS Code bootstrap config', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test('reads extension-host __VSCODE_CONFIG__ before RuntimeAPIs exist', () => {
    (globalThis as { window: unknown }).window = {
      __VSCODE_CONFIG__: {
        workspaceFolder: '/workspace/project-one',
        workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
      },
    };

    expect(getVSCodeBootstrapConfig()).toEqual({
      workspaceFolder: '/workspace/project-one',
      workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
    });
    expect(isVSCodeBootstrapPresent()).toBe(true);
  });

  test('treats missing window/bootstrap as not VS Code', () => {
    expect(getVSCodeBootstrapConfig()).toBeNull();
    expect(isVSCodeBootstrapPresent()).toBe(false);
    expect(isVSCodeBootstrapPresent(null)).toBe(false);
  });
});
