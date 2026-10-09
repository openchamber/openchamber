import { afterAll, expect, test } from 'bun:test';
import { fetchSessionKnowledgeSummary } from './sessionKnowledgeApi';
import { switchRuntimeEndpoint } from './runtime-switch';

const originalFetch = globalThis.fetch;
let body = 'Original';
let fail = false;
let reads = 0;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes('/session-knowledge/summary')) return Response.json({});
  reads += 1;
  return fail ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({
    notes: [{ id: 'n1', body }], plans: [{ id: 'p1', title: 'Plan' }], memory: { global: 0, project: 0 },
  });
}, originalFetch);
afterAll(() => { globalThis.fetch = originalFetch; });

test('peer changes can bypass the cached attachment summary without changing IDs', async () => {
  const initial = await fetchSessionKnowledgeSummary('/summary', 's1');
  body = 'Peer edit';
  expect(await fetchSessionKnowledgeSummary('/summary', 's1')).toEqual(initial);
  expect(reads).toBe(1);
  const refreshed = await fetchSessionKnowledgeSummary('/summary', 's1', { fresh: true });
  expect(refreshed?.notes).toEqual([{ id: 'n1', body: 'Peer edit' }]);
  expect(refreshed?.plans.map(plan => plan.id)).toEqual(['p1']);
  expect(reads).toBe(2);
});

test('failure is distinct from an authoritative empty attachment list', async () => {
  fail = true;
  expect(await fetchSessionKnowledgeSummary('/summary', 's1', { fresh: true })).toBeNull();
  fail = false;
});

test('same-path sessions on another runtime cannot reuse the old summary', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'summary-other' });
  body = 'Other runtime';
  const summary = await fetchSessionKnowledgeSummary('/summary', 's1');
  expect(summary?.notes[0].body).toBe('Other runtime');
});
