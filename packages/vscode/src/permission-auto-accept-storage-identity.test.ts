import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenCodeManager } from './opencode';
import {
  normalizePermissionAutoAcceptStorageIdentity,
  resolvePermissionAutoAcceptStorageIdentity,
} from './permission-auto-accept-storage-identity';

const managerWithIdentity = (identity: string): Pick<OpenCodeManager, 'getPermissionAutoAcceptStorageIdentity'> => ({
  getPermissionAutoAcceptStorageIdentity: () => identity,
});

describe('permission auto-accept storage identity', () => {
  test('prefers the active manager snapshot over mutable configuration', () => {
    const manager = managerWithIdentity('url:https://runtime-a.example');

    const first = resolvePermissionAutoAcceptStorageIdentity({
      manager,
      configuredApiUrl: 'https://config-a.example',
    });
    const second = resolvePermissionAutoAcceptStorageIdentity({
      manager,
      configuredApiUrl: 'https://config-b.example',
    });

    assert.equal(first, 'url:https://runtime-a.example');
    assert.equal(second, 'url:https://runtime-a.example');
  });

  test('changes identity when the active manager snapshot changes', () => {
    const managerA = managerWithIdentity('workspace-local');
    const managerB = managerWithIdentity('url:https://runtime-b.example');

    const first = resolvePermissionAutoAcceptStorageIdentity({
      manager: managerA,
      configuredApiUrl: 'https://config-a.example',
    });
    const second = resolvePermissionAutoAcceptStorageIdentity({
      manager: managerB,
      configuredApiUrl: 'https://config-b.example',
    });

    assert.equal(first, 'workspace-local');
    assert.equal(second, 'url:https://runtime-b.example');
  });

  test('falls back to normalized configured URLs when no manager snapshot exists', () => {
    assert.equal(
      resolvePermissionAutoAcceptStorageIdentity({ configuredApiUrl: 'https://config.example/path/?q=1#hash' }),
      'url:https://config.example/path',
    );
    assert.equal(
      resolvePermissionAutoAcceptStorageIdentity({ configuredApiUrl: '' }),
      'workspace-local',
    );
  });

  test('normalizes configured URLs consistently for manager snapshots', () => {
    assert.equal(normalizePermissionAutoAcceptStorageIdentity('https://runtime.example/path/?q=1#hash'), 'url:https://runtime.example/path');
    assert.equal(normalizePermissionAutoAcceptStorageIdentity(' https://runtime.example/// '), 'url:https://runtime.example');
    assert.equal(normalizePermissionAutoAcceptStorageIdentity(''), 'workspace-local');
  });
});
