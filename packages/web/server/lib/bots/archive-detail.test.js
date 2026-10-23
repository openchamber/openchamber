import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHostFixture } from './host-test-support.js';
import { createBotStore } from './store.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotItem } from './schema.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { createSpaceArchive } from '../spaces/space-archive.js';

const fixtures = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

it.each([false, true])('retains audit detail and captured session links after archival with isolation=%s and no bot definition', async (isolated) => {
  // Given an archived terminal item whose bot and checkout no longer exist.
  let archive = null;
  const f = await createHostFixture({ getSpaceArchive: () => archive }); fixtures.push(f);
  const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
  const item = createBotItem({ id: 'retained', botId: 'removed-bot', source: { kind: 'manual', id: 'retained-source' }, title: 'Retained audit' });
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [item] } }));
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((entry) => ({ ...entry,
    state: 'stopped', worktree: '/removed/host-checkout', sessions: { fixing: 'ses_retained' },
    evidence: [{ source: 'regression', summary: 'Observed before the change' }],
  })) } }));
  const reports = { 'fixing:0': { summary: 'Retained correction report' } };
  const snapshot = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), baseBranch: 'main', changes: [{ newPath: 'src/fix.js' }], diff: 'retained diff' };
  await createBotExecutionStore({ store }).update('project', item.id, (entry) => ({ ...entry, data: { outcomes: reports, snapshot,
    runs: { 'fixing:0': { projectId: 'project', itemId: item.id, directory: '/removed/host-checkout', stage: 'fixing', dispatchedAt: 1, bot: { id: item.botId, isolated } } },
  } }));
  const spaceDirectory = '/spaces/abcdef123456/project';
  const directory = isolated ? path.join(f.dataDir, 'spaces/archive/abcdef123456') : '/removed/host-checkout';
  if (isolated) {
    const key = { projectId: 'project', itemId: item.id };
    const bindings = path.join(f.dataDir, 'bots', 'isolated-stages');
    await fs.mkdir(bindings, { recursive: true });
    await fs.writeFile(path.join(bindings, `${digestMutationInput(key)}.json`), JSON.stringify({ version: 1, ...key,
      botId: item.botId, hostDirectory: '/removed/host-checkout', state: 'removed', spaceId: 'abcdef123456', directory: spaceDirectory,
      sessions: { fixing: { id: 'ses_retained', stage: 'fixing', directory: spaceDirectory } },
    }));
    archive = createSpaceArchive({ dataDir: f.dataDir, hostOpenCode: { importChat: async () => {}, removeChat: async () => {} } });
    await archive.saveChats({ spaceId: 'abcdef123456', name: 'Removed bot space', projectDirectory: null,
      source: { listChats: async () => ({ chats: [{ id: 'ses_retained' }], complete: true }), exportChat: async () => ({
        info: { id: 'ses_retained', projectID: 'project', cost: 0, time: { created: 1, updated: 2 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, messages: [],
      }) },
    });
  }
  await store.archive('project', { before: Date.now() + 1 });
  await f.host.start();

  // When the ordinary read-only item route inspects the retained item.
  const result = await f.request(`/items/${item.id}`);

  // Then retained evidence and addresses remain available without starting any provider.
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ item: { id: item.id, state: 'stopped', evidence: [{ source: 'regression' }] }, reports, snapshot,
    sessionDirectories: { ses_retained: directory } });
  expect((await f.request('/items')).body.items).toEqual([]);
  expect((await f.request(`/items/${item.id}/resume`, 'POST', {})).status).toBe(404);
  expect((await f.request(`/items/${item.id}/stop`, 'POST', {})).status).toBe(404);
  expect((await f.request(`/items/${item.id}/answer`, 'POST', { text: 'Late answer', eventId: 'late' })).status).toBe(404);
  expect((await f.request('/items/absent')).status).toBe(404);
  expect(f.calls.http).toHaveLength(0);
});
