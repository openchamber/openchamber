import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createTrackedItemsInterest } from './interest';
import type { TrackedItem, TrackedItemState } from './model';

type Request = { path: string; body: { connectionId: string; visible: boolean; items?: TrackedItem[] } };

const pull = (number: number): TrackedItem => ({ provider: 'github', kind: 'pull', owner: 'acme', repo: 'app', number });

function setup() {
  let listener: ((event: { type: 'event-stream-ready'; connectionId: string | null }) => void) | null = null;
  let visibilityListener: (() => void) | null = null;
  let visible = true;
  const posts: Request[] = [];
  const applied: Array<Array<{ key: string; record: TrackedItemState }>> = [];
  let respond: (path: string) => Response = () => Response.json({ states: [] });
  const interest = createTrackedItemsInterest({
    subscribe: (next) => { listener = next; },
    post: async (request) => { posts.push({ path: request.path, body: { ...request.body } }); return respond(request.path); },
    apply: (records: Array<{ key: string; record: TrackedItemState }>) => { applied.push(records); },
    isVisible: () => visible,
    onVisibilityChange: (next) => { visibilityListener = next; },
  });
  return {
    interest,
    posts,
    applied,
    ready: (connectionId: string) => listener?.({ type: 'event-stream-ready', connectionId }),
    setVisible: (value: boolean) => { visible = value; visibilityListener?.(); },
    respondWith: (next: (path: string) => Response) => { respond = next; },
  };
}

const settle = async (ms = 200) => {
  jest.advanceTimersByTime(ms);
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('tracked items interest', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('sends the union once the connection is known, once per change, and again after a reconnect', async () => {
    const { interest, posts, ready } = setup();
    const sidebar = Symbol('sidebar');
    const panel = Symbol('panel');
    interest.declare(sidebar, [pull(1), pull(2)]);
    interest.declare(panel, [pull(2)]);
    await settle();
    expect(posts).toHaveLength(0);

    ready('c1');
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: '/api/tracked-items/interest', body: { connectionId: 'c1', visible: true } });
    expect(posts[0].body.items).toHaveLength(2);

    interest.declare(panel, [pull(2)]);
    await settle();
    expect(posts).toHaveLength(1);

    ready('c2');
    await settle(0);
    expect(posts.map((post) => post.body.connectionId)).toEqual(['c1', 'c2']);
  });

  test('tells the server when nothing is shown any more and when the window flips', async () => {
    const { interest, posts, ready, setVisible } = setup();
    const token = Symbol('row');
    interest.declare(token, [pull(1)]);
    ready('c1');
    await settle(0);
    interest.release(token);
    await settle();
    expect(posts[1].body.items).toEqual([]);

    setVisible(false);
    await settle(0);
    expect(posts[2]).toEqual({ path: '/api/tracked-items/presence', body: { connectionId: 'c1', visible: false } });
  });

  test('retries a failed send later and waits for the next connection after a 409', async () => {
    const { interest, posts, ready, respondWith } = setup();
    respondWith(() => new Response('down', { status: 503 }));
    interest.declare(Symbol('row'), [pull(1)]);
    ready('c1');
    await settle(0);
    expect(posts).toHaveLength(1);
    respondWith(() => Response.json({ states: [] }));
    await settle(30_000);
    expect(posts).toHaveLength(2);

    respondWith(() => new Response('gone', { status: 409 }));
    interest.declare(Symbol('other'), [pull(9)]);
    await settle();
    expect(posts).toHaveLength(3);
    await settle(60_000);
    expect(posts).toHaveLength(3);
  });
});
