import { expect, mock, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getMultiRunIdentity, withMultiRunMembership } from './identity';

const calls: string[] = [];
let getSessionImpl: (id: string, directory?: string | null) => Promise<Session>;
let getSessionMessagesImpl: (id: string, options?: { limit?: number }, directory?: string | null) => Promise<{
  items: Array<{ info: { role: string }; parts: Array<{ type: string; text: string }> }>;
}>;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSession: (id: string, directory?: string | null) => {
      calls.push(`session:${id}:${directory}`);
      return getSessionImpl(id, directory);
    },
    getSessionMessages: (id: string, options?: { limit?: number }, directory?: string | null) => {
      calls.push(`messages:${id}:${directory}`);
      return getSessionMessagesImpl(id, options, directory);
    },
  },
}));

const { loadFusionOutputs } = await import('./fusion');
type FusionSource = Parameters<typeof loadFusionOutputs>[0][number];

const session: Session = {
  id: 'run', directory: '/repo', projectID: 'project', title: 'renamed freely',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: withMultiRunMembership({}, {
    version: 1, sessionID: 'run', group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
    groupSlug: 'bench', role: 'run', providerID: 'openrouter', modelID: 'vendor/model',
  }),
};
const identity = getMultiRunIdentity(session);
if (!identity) throw new Error('Fixture must have membership');
const source: FusionSource = { session, identity, directory: '/repo', projectDirectory: '/repo' };

const reset = () => {
  calls.length = 0;
  getSessionImpl = async () => session;
  getSessionMessagesImpl = async () => ({ items: [] });
};

test('fusion loads the selected session by ID and uses its current last assistant output', async () => {
  reset();
  getSessionImpl = async () => ({ ...session, title: 'renamed again' });
  // v2 pages messages newest first.
  getSessionMessagesImpl = async () => ({
    items: [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'latest result' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'question' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'older' }] },
    ],
  });
  const result = await loadFusionOutputs([source], source.identity, () => {});
  expect(result.map((item) => item.text)).toEqual(['latest result']);
  expect(result[0].source.session.title).toBe('renamed again');
  expect(calls).toEqual(['session:run:/repo', 'messages:run:/repo']);
});

test('fusion stops before fetching output when a selected ID no longer owns membership', async () => {
  reset();
  getSessionImpl = async () => ({ ...session, id: 'fork' });
  await expect(loadFusionOutputs([source], source.identity, () => {})).rejects.toThrow('membership changed');
  expect(calls).toEqual(['session:run:/repo']);
});

test('fusion read failure is not silently treated as an empty source', async () => {
  reset();
  getSessionMessagesImpl = async () => { throw new Error('unavailable'); };
  await expect(loadFusionOutputs([source], source.identity, () => {})).rejects.toThrow('unavailable');
});

test('a runtime switch during source lookup stops the next request', async () => {
  reset();
  let switched = false;
  getSessionImpl = async () => { switched = true; return session; };
  await expect(loadFusionOutputs([source], source.identity, () => {
    if (switched) throw new Error('Runtime changed');
  })).rejects.toThrow('Runtime changed');
  expect(calls).toEqual(['session:run:/repo']);
});
