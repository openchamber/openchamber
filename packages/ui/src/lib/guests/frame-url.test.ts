import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { resolveGuestFrameUrl } from './frame-url';

const descriptor = { relayUrl: 'wss://relay.test', serverId: 'server', hostEncPubJwk: {} };
let dom: Window;
let previousParser: PropertyDescriptor | undefined;
let reads: string[] = [];
let answer: (signal?: AbortSignal | null) => Promise<Response>;

const page = () => new Response('<html><head></head><body>hi</body></html>', { headers: { 'content-type': 'text/html' } });
let keyCounter = 0;
const nextKey = () => `key-${(keyCounter += 1)}`;

beforeEach(() => {
  reads = [];
  answer = async () => page();
  dom = new Window();
  previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.DOMParser });
  const tunnel: RelayTunnelClient = {
    fetch: (input, init) => {
      reads.push(String(input));
      return answer(init?.signal);
    },
    openWebSocket() { throw new Error('unused'); },
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => {},
    retry() {},
    close() {},
  };
  adoptRelayTunnel(descriptor, tunnel);
});

afterEach(async () => {
  deactivateRelayTunnel();
  if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
  else Reflect.deleteProperty(globalThis, 'DOMParser');
  await dom.happyDOM.close();
});

describe('relay frame documents', () => {
  test('frames that appear together share one read, and a later one reads nothing', async () => {
    const key = nextKey();
    const load = () => resolveGuestFrameUrl('demo', 'block.html', undefined, [], key);
    const [first, second, third] = await Promise.all([load(), load(), load()]);
    expect(reads).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    await load();
    expect(reads).toHaveLength(1);
  });

  test('a frame going away leaves the read to the frames still waiting', async () => {
    let finish = (_response: Response) => {};
    answer = () => new Promise((resolve) => { finish = resolve; });
    const key = nextKey();
    const leaving = new AbortController();
    const left = resolveGuestFrameUrl('demo', 'block.html', leaving.signal, [], key);
    const staying = resolveGuestFrameUrl('demo', 'block.html', undefined, [], key);
    await Promise.resolve();
    leaving.abort();
    await expect(left).rejects.toThrow();
    finish(page());
    expect((await staying).kind).toBe('document');
    expect(reads).toHaveLength(1);
  });

  test('the last frame leaving cancels the read, and the next frame starts over', async () => {
    let seen: AbortSignal | null | undefined;
    answer = (signal) => {
      seen = signal;
      return new Promise(() => {});
    };
    const key = nextKey();
    const leaving = new AbortController();
    const left = resolveGuestFrameUrl('demo', 'block.html', leaving.signal, [], key);
    await Promise.resolve();
    leaving.abort();
    await expect(left).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
    answer = async () => page();
    expect((await resolveGuestFrameUrl('demo', 'block.html', undefined, [], key)).kind).toBe('document');
  });

  test('a read lost to a reconnect goes once more, and a failed read is not kept', async () => {
    let failures = 1;
    answer = async () => {
      if (failures-- > 0) throw markAmbiguousTransportFailure(new Error('stream lost'));
      return page();
    };
    expect((await resolveGuestFrameUrl('demo', 'block.html', undefined, [], nextKey())).kind).toBe('document');
    expect(reads).toHaveLength(2);

    reads = [];
    failures = 2;
    const key = nextKey();
    await expect(resolveGuestFrameUrl('demo', 'block.html', undefined, [], key)).rejects.toThrow('stream lost');
    expect(reads).toHaveLength(2);
    expect((await resolveGuestFrameUrl('demo', 'block.html', undefined, [], key)).kind).toBe('document');
  });

  test('a document too large to keep is read again', async () => {
    const big = 'x'.repeat(32_000_001);
    answer = async () => new Response(`<html><head></head><body>${big}</body></html>`, { headers: { 'content-type': 'text/html' } });
    const key = nextKey();
    await resolveGuestFrameUrl('demo', 'block.html', undefined, [], key);
    await resolveGuestFrameUrl('demo', 'block.html', undefined, [], key);
    expect(reads).toHaveLength(2);
  });
});
