import { describe, expect, test } from 'bun:test';
import { isVSCodeRuntime } from './vscodeRuntime';

describe('VS Code runtime detection', () => {
  test('uses extension-host bootstrap config before runtime APIs are registered', () => {
    expect(isVSCodeRuntime(null, {
      workspaceFolder: '/workspace/project-one',
      workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
    })).toBe(true);
  });

  test('does not classify an unregistered web runtime as VS Code', () => {
    expect(isVSCodeRuntime(null, null)).toBe(false);
  });
});
