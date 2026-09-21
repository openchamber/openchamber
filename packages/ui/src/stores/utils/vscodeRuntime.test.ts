import { describe, expect, test } from 'bun:test';
import type { RuntimeAPIs } from '@/lib/api/types';
import { isVSCodeRuntime } from './vscodeRuntime';

describe('VS Code runtime detection', () => {
  test('uses extension-host bootstrap config before runtime APIs are registered', () => {
    expect(isVSCodeRuntime(null, {
      workspaceFolder: '/workspace/project-one',
      workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
    })).toBe(true);
  });

  test('uses registered runtime APIs when bootstrap is absent', () => {
    const runtimeApis = {
      runtime: { platform: 'vscode', isDesktop: false, isVSCode: true },
    } as RuntimeAPIs;
    expect(isVSCodeRuntime(runtimeApis, null)).toBe(true);
  });

  test('does not classify an unregistered web runtime as VS Code', () => {
    expect(isVSCodeRuntime(null, null)).toBe(false);
  });
});
