import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { collectTrayStatusPollTargets, readSyncedDirectories } from './tray-status-poll';

// Separate file on purpose: sync refs are module-level and have no uninstall, so
// "SyncProvider never mounted" is only observable in a process where nothing
// called `setSyncRefs`. The isolated-test runner gives every file its own.

const DIRECTORY = '/workspace/catalog';

const makeSession = (id: string, directory: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  directory,
  title: id,
  version: '1',
  time: { created: 1, updated: 1 },
});

describe('tray status poll without a mounted sync provider', () => {
  test('reports no synced directories instead of throwing', () => {
    expect([...readSyncedDirectories()]).toEqual([]);
  });

  test('keeps polling every visible directory', () => {
    const targets = collectTrayStatusPollTargets({
      sessions: [makeSession('ses_root', DIRECTORY)],
      syncedDirectories: readSyncedDirectories(),
      compareSessions: (left, right) => (left.id < right.id ? -1 : 1),
    });

    expect(targets.get(DIRECTORY)).toEqual(['ses_root']);
  });
});
