import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Snippet } from '@/types/snippet';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { useDirectoryStore } from './useDirectoryStore';
import { useSnippetsStore } from './useSnippetsStore';

const originalResolver = getRuntimeUrlResolver();
const originalFetch = globalThis.fetch;
const originalNow = Date.now;

const snippet = (name: string): Snippet => ({
  name,
  content: `${name} body`,
  aliases: [],
  filePath: `/snippets/${name}.md`,
  source: 'global',
});

type Handler = (request: Request) => Promise<Response> | Response;
let requests: Request[] = [];
let handle: Handler = () => Response.json([]);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://snippets.example' });
  requests = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return handle(request);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  setRuntimeUrlResolver(originalResolver);
});

const listReads = () => requests.filter((request) => request.method === 'GET');
const expandCalls = () => requests.filter((request) => request.url.includes('/api/config/snippets/expand'));

describe('snippet registry', () => {
  test('rules out an expansion only while the loaded list is fresh', async () => {
    useDirectoryStore.setState({ currentDirectory: '/repo-ttl' });
    const start = originalNow();
    Date.now = () => start;
    handle = (request) => (
      request.url.includes('/expand')
        ? Response.json({ text: 'release body' })
        : Response.json([snippet('deploy')])
    );
    expect(await useSnippetsStore.getState().loadSnippets()).toBe(true);

    // Fresh list without the token: no round trip.
    expect(await useSnippetsStore.getState().expandText('fix #42')).toBe('fix #42');
    expect(expandCalls()).toHaveLength(0);

    // Before: the list counted as complete forever, so a snippet added on disk
    // afterwards was never expanded. Past the load cache the server decides.
    Date.now = () => start + 6_000;
    expect(await useSnippetsStore.getState().expandText('#release')).toBe('release body');
    expect(expandCalls()).toHaveLength(1);
  });

  test('a change does not reuse a load started before it', async () => {
    useDirectoryStore.setState({ currentDirectory: '/repo-generation' });
    const staleRead = deferred<Response>();
    let reads = 0;
    handle = (request) => {
      if (request.method === 'POST') return Response.json({ ok: true });
      reads += 1;
      // The first read started before the change; it answers last, with the old list.
      return reads === 1 ? staleRead.promise : Response.json([snippet('deploy')]);
    };

    const earlyLoad = useSnippetsStore.getState().loadSnippets();
    expect(await useSnippetsStore.getState().createSnippet('deploy', 'deploy body')).toBe(true);
    expect(listReads()).toHaveLength(2);
    expect(useSnippetsStore.getState().snippets.map((item) => item.name)).toEqual(['deploy']);

    staleRead.resolve(Response.json([]));
    expect(await earlyLoad).toBe(true);
    // Before: the create awaited the early read and published its empty list.
    expect(useSnippetsStore.getState().snippets.map((item) => item.name)).toEqual(['deploy']);
    expect(useSnippetsStore.getState().isLoading).toBe(false);
  });
});
