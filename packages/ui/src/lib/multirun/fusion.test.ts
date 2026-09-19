import { expect, test } from 'bun:test';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { loadFusionOutputs, type FusionSource } from './fusion';
import { getMultiRunIdentity, withMultiRunMembership } from './identity';

const session: Session = {
  id: 'run', slug: 'run', directory: '/repo', projectID: 'project', version: '1',
  title: 'renamed freely', time: { created: 1, updated: 1 },
  metadata: withMultiRunMembership({}, {
    version: 1, sessionID: 'run', group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
    groupSlug: 'bench', role: 'run', providerID: 'openrouter', modelID: 'vendor/model',
  }),
};
const identity = getMultiRunIdentity(session);
if (!identity) throw new Error('Fixture must have membership');
const source: FusionSource = { session, identity, directory: '/repo', projectDirectory: '/repo' };

test('fusion loads the selected session by ID and uses its current last assistant output', async () => {
  const paths: string[] = [];
  const client = createOpencodeClient({ baseUrl: 'http://fusion.test', fetch: async (request) => {
    const url = new URL(new Request(request).url);
    paths.push(url.pathname);
    expect(url.searchParams.get('directory')).toBe('/repo');
    if (!url.pathname.endsWith('/message')) return Response.json({ ...session, title: 'renamed again' });
    return Response.json([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'older' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'question' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'latest result' }] },
    ]);
  } });
  const result = await loadFusionOutputs(client, [source], source.identity, () => {});
  expect(result.map((item) => item.text)).toEqual(['latest result']);
  expect(result[0].source.session.title).toBe('renamed again');
  expect(paths).toEqual(['/session/run', '/session/run/message']);
});

test('fusion stops before fetching output when a selected ID no longer owns membership', async () => {
  const paths: string[] = [];
  const client = createOpencodeClient({ baseUrl: 'http://fusion.test', fetch: async (request) => {
    paths.push(new URL(new Request(request).url).pathname);
    return Response.json({ ...session, id: 'fork' });
  } });
  await expect(loadFusionOutputs(client, [source], source.identity, () => {})).rejects.toThrow('membership changed');
  expect(paths).toEqual(['/session/run']);
});

test('fusion read failure is not silently treated as an empty source', async () => {
  const client = createOpencodeClient({ baseUrl: 'http://fusion.test', fetch: async (request) => {
    if (new URL(new Request(request).url).pathname.endsWith('/message')) return Response.json({ message: 'unavailable' }, { status: 503 });
    return Response.json(session);
  } });
  await expect(loadFusionOutputs(client, [source], source.identity, () => {})).rejects.toThrow();
});

test('a runtime switch during source lookup stops the next request', async () => {
  let switched = false;
  let requests = 0;
  const client = createOpencodeClient({ baseUrl: 'http://fusion.test', fetch: async () => {
    requests += 1;
    switched = true;
    return Response.json(session);
  } });
  await expect(loadFusionOutputs(client, [source], source.identity, () => {
    if (switched) throw new Error('Runtime changed');
  })).rejects.toThrow('Runtime changed');
  expect(requests).toBe(1);
});
