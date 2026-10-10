import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createArchiveStore } from './archive-store.js';
import { prepareUserMessageResume } from './user-message-resume.js';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-session-'));
  directories.push(directory);
  const archiveStore = createArchiveStore({ dataDir: directory });
  await archiveStore.archive(['root', 'child', 'other'], 10);
  const broadcasts = [];
  const deps = {
    archiveStore,
    getSession: async (id) => ({ id, parentID: id === 'child' ? 'root' : undefined, time: {} }),
    getChildren: async (id) => id === 'root' ? ['child'] : [],
    broadcastRestored: (id) => broadcasts.push(id),
  };
  return { directory, archiveStore, broadcasts, deps };
}

describe('queued user message archive restoration', () => {
  it('only restores the captured tree after acceptance and persists it across restart', async () => {
    const { deps, archiveStore, broadcasts, directory } = await fixture();
    const resume = await prepareUserMessageResume('root', deps);
    expect(await archiveStore.isArchived('root')).toBe(true);
    expect(broadcasts).toEqual([]);
    await resume();
    expect(broadcasts).toEqual(['root', 'child']);
    const restarted = createArchiveStore({ dataDir: directory });
    expect(await restarted.getAll()).toEqual({ root: null, child: null, other: 10 });
  });

  it('a later archive wins, including against a restore waiting for the write lock', async () => {
    const { deps, archiveStore, broadcasts } = await fixture();
    const resume = await prepareUserMessageResume('root', deps);
    const archive = archiveStore.archive(['root', 'child'], 20);
    await resume();
    await archive;
    expect(broadcasts).toEqual([]);
    expect(await archiveStore.archivedAt('root')).toBe(20);
    expect(await archiveStore.archivedAt('child')).toBe(20);
  });

  it('does not restore an active root, a subsession, or an explicitly restored migrated session', async () => {
    const { deps, archiveStore, broadcasts } = await fixture();
    await (await prepareUserMessageResume('child', deps))();
    await archiveStore.unarchive(['root']);
    await (await prepareUserMessageResume('root', {
      ...deps, getSession: async (id) => ({ id, time: { archived: 5 } }),
    }))();
    expect(broadcasts).toEqual([]);
    expect(await archiveStore.isArchived('child')).toBe(true);
  });

  it('restores a migrated archive that has no local override', async () => {
    const { deps, archiveStore, broadcasts } = await fixture();
    await (await prepareUserMessageResume('legacy', {
      ...deps, getSession: async (id) => ({ id, time: { archived: 5 } }),
    }))();
    expect((await archiveStore.getAll()).legacy).toBeNull();
    expect(broadcasts).toEqual(['legacy']);
  });

  it('a failed child restore does not block its sibling or undo the root', async () => {
    const { deps, archiveStore, broadcasts } = await fixture();
    const resume = await prepareUserMessageResume('root', {
      ...deps,
      getChildren: async (id) => id === 'root' ? ['child', 'other'] : [],
      archiveStore: {
        ...archiveStore,
        unarchiveUnchanged: (id, stamp) => id === 'child'
          ? Promise.resolve({ restored: [], failedIds: [id] })
          : archiveStore.unarchiveUnchanged(id, stamp),
      },
    });
    await expect(resume()).rejects.toThrow('Could not restore some archived subsessions');
    expect(broadcasts).toEqual(['root', 'other']);
    expect(await archiveStore.isArchived('child')).toBe(true);
  });

  it('keeps the root archived and sends no confirmation when persistence fails', async () => {
    const { deps, archiveStore, directory, broadcasts } = await fixture();
    const resume = await prepareUserMessageResume('root', deps);
    fs.rmSync(directory, { recursive: true });
    fs.writeFileSync(directory, 'not a directory');
    await expect(resume()).rejects.toThrow('Could not restore archived session');
    expect(await archiveStore.archivedAt('root')).toBe(10);
    expect(broadcasts).toEqual([]);
  });
});
