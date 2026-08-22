import { afterEach, describe, expect, mock, test } from 'bun:test';

type RuntimeApisStub = { runtime?: { isVSCode?: boolean } } | null;

let registeredRuntimeApis: RuntimeApisStub = null;

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: (): RuntimeApisStub => registeredRuntimeApis,
}));

const { isVSCodeRuntime } = await import('./desktop');

describe('desktop isVSCodeRuntime bootstrap detection', () => {
  afterEach(() => {
    registeredRuntimeApis = null;
    delete (globalThis as { window?: unknown }).window;
  });

  test('detects VS Code from bootstrap config before RuntimeAPIs register', () => {
    registeredRuntimeApis = null;
    (globalThis as { window: unknown }).window = {
      __VSCODE_CONFIG__: {
        workspaceFolder: '/Users/me/project-a',
        workspaceFolders: [{ name: 'project-a', path: '/Users/me/project-a' }],
      },
    };

    expect(isVSCodeRuntime()).toBe(true);
  });

  test('falls back to registered RuntimeAPIs when bootstrap is absent', () => {
    registeredRuntimeApis = {
      runtime: { isVSCode: true },
    };
    (globalThis as { window: unknown }).window = {};

    expect(isVSCodeRuntime()).toBe(true);
  });

  test('does not classify an unregistered web runtime as VS Code', () => {
    registeredRuntimeApis = null;
    (globalThis as { window: unknown }).window = {};

    expect(isVSCodeRuntime()).toBe(false);
  });
});
