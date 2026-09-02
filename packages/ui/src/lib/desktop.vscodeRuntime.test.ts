import { afterEach, describe, expect, mock, test } from 'bun:test';

type RuntimeApisStub = { runtime?: { isVSCode?: boolean } } | null;

let registeredRuntimeApis: RuntimeApisStub = null;

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: (): RuntimeApisStub => registeredRuntimeApis,
}));

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

const { isVSCodeRuntime } = await import('./desktop');

describe('desktop isVSCodeRuntime bootstrap detection', () => {
  afterEach(() => {
    registeredRuntimeApis = null;
    setTestWindow(undefined);
  });

  test('detects VS Code from bootstrap config before RuntimeAPIs register', () => {
    registeredRuntimeApis = null;
    setTestWindow({
      __VSCODE_CONFIG__: {
        workspaceFolder: '/Users/me/project-a',
        workspaceFolders: [{ name: 'project-a', path: '/Users/me/project-a' }],
      },
    });

    expect(isVSCodeRuntime()).toBe(true);
  });

  test('falls back to registered RuntimeAPIs when bootstrap is absent', () => {
    registeredRuntimeApis = {
      runtime: { isVSCode: true },
    };
    setTestWindow({});

    expect(isVSCodeRuntime()).toBe(true);
  });

  test('does not classify an unregistered web runtime as VS Code', () => {
    registeredRuntimeApis = null;
    setTestWindow({});

    expect(isVSCodeRuntime()).toBe(false);
  });
});
