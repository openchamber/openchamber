import { afterEach, describe, expect, test } from 'bun:test';
import { getVSCodeBootstrapConfig, isVSCodeBootstrapPresent } from './vscodeBootstrap';

interface TestWindow {
  __VSCODE_CONFIG__?: { workspaceFolder: string; workspaceFolders: { name: string; path: string }[] };
}

/**
 * bun test runs without a DOM, so `globalThis` has no `window` binding to
 * assign through. Defining the property directly installs the stub without
 * asserting that it is a real `Window`.
 */
const setTestWindow = (value: TestWindow | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    return;
  }
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
};

describe('VS Code bootstrap config', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('reads extension-host __VSCODE_CONFIG__ before RuntimeAPIs exist', () => {
    setTestWindow({
      __VSCODE_CONFIG__: {
        workspaceFolder: '/workspace/project-one',
        workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
      },
    });

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
