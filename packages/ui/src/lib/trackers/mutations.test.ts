import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The transport is stubbed at the same seam every other tracker call takes, so
// these tests hold the mutations' own contract: path, method, body, and what
// counts as a failure.
type RecordedRequest = { path: string; init: RequestInit };

const requests: RecordedRequest[] = [];
let nextResponse: Response;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init });
    return nextResponse;
  },
}));

const { createTrackerItem, editTrackerItem } = await import('./mutations');

const ITEM = {
  id: 'LOCAL-1', identifier: 'LOCAL-1', title: 'First', provider: 'local', url: '', state: null, description: null,
};

beforeEach(() => {
  requests.length = 0;
  nextResponse = Response.json({ connected: true, item: ITEM });
});

describe('createTrackerItem', () => {
  test('posts JSON to the provider create route and resolves with the item', async () => {
    const item = await createTrackerItem('local', { containerId: 'p1', title: 'First', priority: 'high', labels: ['bug'] });
    expect(item).toEqual(ITEM);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/tracker/local/items/create');
    expect(requests[0].init.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      containerId: 'p1', title: 'First', priority: 'high', labels: ['bug'],
    });
  });

  test('encodes the provider into the path', async () => {
    await createTrackerItem('some provider', { containerId: 'p1', title: 'x' });
    expect(requests[0].path).toBe('/api/tracker/some%20provider/items/create');
  });

  test('rejects with the server error message on a non-2xx answer', async () => {
    nextResponse = Response.json({ error: 'containerId is required' }, { status: 400 });
    await expect(createTrackerItem('local', { containerId: '', title: 'x' })).rejects.toThrow('containerId is required');
  });

  test('rejects when a 200 answer does not carry an item', async () => {
    nextResponse = Response.json({ connected: false });
    await expect(createTrackerItem('local', { containerId: 'p1', title: 'x' })).rejects.toThrow('Failed to create the tracker item');
  });
});

describe('editTrackerItem', () => {
  test('posts JSON to the provider edit route, forwarding only the fields given', async () => {
    await editTrackerItem('local', { id: 'LOCAL-1', title: 'Renamed' });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/tracker/local/items/edit');
    expect(requests[0].init.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ id: 'LOCAL-1', title: 'Renamed' });
  });

  test('rejects with the server error message on a non-2xx answer', async () => {
    nextResponse = Response.json({ error: 'id is required' }, { status: 400 });
    await expect(editTrackerItem('local', { id: '' })).rejects.toThrow('id is required');
  });
});
