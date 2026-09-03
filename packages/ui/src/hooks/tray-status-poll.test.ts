import { afterEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import {
  TRAY_MAX_SESSIONS,
  collectTrayStatusPollTargets,
  readSyncedDirectories,
} from './tray-status-poll';

const SYNCED_DIRECTORY = '/workspace/catalog';
const UNSYNCED_DIRECTORY = '/workspace/archive';

const makeSession = (id: string, directory: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  directory,
  title: id,
  version: '1',
  time: { created: 1, updated: 1 },
});

const makeChildSession = (id: string, directory: string, parentID: string): Session => ({
  ...makeSession(id, directory),
  parentID,
});

const byId = (left: Session, right: Session): number => (left.id < right.id ? -1 : 1);

const managers: ChildStoreManager[] = [];

const setSyncedDirectories = (...directories: string[]): ChildStoreManager => {
  const manager = new ChildStoreManager();
  managers.push(manager);
  for (const directory of directories) manager.ensureChild(directory, { bootstrap: false });
  // SAFETY: `setSyncRefs` only stores the SDK for other readers; nothing here calls it.
  setSyncRefs({} as never, manager, directories[0] ?? '');
  return manager;
};

afterEach(() => {
  for (const manager of managers.splice(0)) manager.disposeAll();
  // SAFETY: same unused SDK slot; drops the refs this file installed.
  setSyncRefs({} as never, new ChildStoreManager(), '');
});

describe('collectTrayStatusPollTargets', () => {
  test('excludes a directory that already has an initialized child store', () => {
    const sessions = [
      makeSession('ses_synced', SYNCED_DIRECTORY),
      makeSession('ses_unsynced', UNSYNCED_DIRECTORY),
    ];

    const targets = collectTrayStatusPollTargets({
      sessions,
      syncedDirectories: new Set([SYNCED_DIRECTORY]),
      compareSessions: byId,
    });

    expect([...targets.keys()]).toEqual([UNSYNCED_DIRECTORY]);
    expect(targets.get(UNSYNCED_DIRECTORY)).toEqual(['ses_unsynced']);
  });

  test('keeps every visible directory when no child store is initialized', () => {
    const sessions = [
      makeSession('ses_synced', SYNCED_DIRECTORY),
      makeSession('ses_unsynced', UNSYNCED_DIRECTORY),
    ];

    const targets = collectTrayStatusPollTargets({
      sessions,
      syncedDirectories: new Set(),
      compareSessions: byId,
    });

    expect([...targets.keys()].sort()).toEqual([UNSYNCED_DIRECTORY, SYNCED_DIRECTORY].sort());
  });

  test('groups child session ids under their unsynced root directory', () => {
    const sessions = [
      makeSession('ses_root', UNSYNCED_DIRECTORY),
      makeChildSession('ses_child', UNSYNCED_DIRECTORY, 'ses_root'),
      makeChildSession('ses_synced_child', SYNCED_DIRECTORY, 'ses_synced_root'),
    ];

    const targets = collectTrayStatusPollTargets({
      sessions,
      syncedDirectories: new Set([SYNCED_DIRECTORY]),
      compareSessions: byId,
    });

    expect(targets.get(UNSYNCED_DIRECTORY)).toEqual(['ses_root', 'ses_child']);
    expect(targets.has(SYNCED_DIRECTORY)).toBe(false);
  });

  test('targets only the directories of the tray-visible root sessions', () => {
    const sessions = Array.from({ length: TRAY_MAX_SESSIONS + 1 }, (_unused, index) => (
      makeSession(`ses_${String(index).padStart(3, '0')}`, `/workspace/project-${index}`)
    ));

    const targets = collectTrayStatusPollTargets({
      sessions,
      syncedDirectories: new Set(),
      compareSessions: byId,
    });

    expect(targets.size).toBe(TRAY_MAX_SESSIONS);
    expect(targets.has(`/workspace/project-${TRAY_MAX_SESSIONS}`)).toBe(false);
  });

  test('matches a session directory against a differently formatted child store key', () => {
    const targets = collectTrayStatusPollTargets({
      sessions: [makeSession('ses_synced', `${SYNCED_DIRECTORY}/`)],
      syncedDirectories: new Set([SYNCED_DIRECTORY]),
      compareSessions: byId,
    });

    expect(targets.size).toBe(0);
  });
});

describe('readSyncedDirectories', () => {
  test('reports the directories that have an initialized child store', () => {
    setSyncedDirectories(SYNCED_DIRECTORY);

    expect([...readSyncedDirectories()]).toEqual([SYNCED_DIRECTORY]);
  });

  test('drops a synced directory from the tray poll while an unsynced one stays', () => {
    setSyncedDirectories(SYNCED_DIRECTORY);

    const targets = collectTrayStatusPollTargets({
      sessions: [
        makeSession('ses_synced', SYNCED_DIRECTORY),
        makeSession('ses_unsynced', UNSYNCED_DIRECTORY),
      ],
      syncedDirectories: readSyncedDirectories(),
      compareSessions: byId,
    });

    expect([...targets.keys()]).toEqual([UNSYNCED_DIRECTORY]);
  });
});
