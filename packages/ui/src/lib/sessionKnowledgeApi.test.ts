import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { fetchSessionKnowledgeSummary, setSessionProjectContextPin, syncSessionKnowledge } from './sessionKnowledgeApi';
import { switchRuntimeEndpoint } from './runtime-switch';

const SPACE_DIRECTORY = '/spaces/a1b2c3d4e5f6/repo';

let request: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;

const capturePaths = (): string[] => {
  const paths: string[] = [];
  request = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    // The path and the directory header together say where the request goes.
    const directory = new Headers(init?.headers).get('x-opencode-directory');
    paths.push(`${new URL(input instanceof Request ? input.url : String(input), 'http://app.test').pathname} ${directory ?? '-'}`);
    return Response.json({ recorded: true, pins: { notes: ['note-1'], plans: [] } });
  });
  return paths;
};

afterEach(() => {
  request?.mockRestore();
  request = null;
});

// The session lives in the space's OpenCode, so a write or pin that reaches
// the host's server finds no session and changes nothing.
describe('session knowledge writes for a session in an isolated space', () => {
  test('the knowledge write reaches the server inside the space', async () => {
    const paths = capturePaths();
    await syncSessionKnowledge(SPACE_DIRECTORY, 'session-1');
    expect(paths).toEqual([`/api/session-knowledge/sync ${encodeURIComponent(SPACE_DIRECTORY)}`]);
  });

  test('a pin reaches the server inside the space', async () => {
    const paths = capturePaths();
    expect(await setSessionProjectContextPin(SPACE_DIRECTORY, 'session-1', 'note', 'note-1', true)).toEqual({ notes: ['note-1'], plans: [] });
    expect(paths).toEqual([`/api/session-knowledge/pin ${encodeURIComponent(SPACE_DIRECTORY)}`]);
  });

  test('a host session stays on the host', async () => {
    const paths = capturePaths();
    await syncSessionKnowledge('/home/me/repo', 'session-1');
    await setSessionProjectContextPin('/home/me/repo', 'session-1', 'note', 'note-1', true);
    expect(paths).toEqual(['/api/session-knowledge/sync -', '/api/session-knowledge/pin -']);
  });
});

// Issue #2160: the summary cache was keyed by directory + session only, so a
// fetch made just before a runtime switch answered for the new runtime until
// the freshness window expired.
describe('session knowledge summary cache across a runtime switch', () => {
  test('a post-switch fetch requests the new runtime instead of reusing the cached promise', async () => {
    const directory = '/home/me/knowledge-cache-runtime-switch';
    let calls = 0;
    request = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      // switchRuntimeEndpoint also mints a URL auth token through fetch;
      // only summary requests count here.
      if (!url.includes('/api/session-knowledge/summary')) {
        return Response.json({});
      }
      calls += 1;
      const fromA = url.startsWith('http://runtime-a.test');
      return Response.json({
        notes: [{ id: fromA ? 'note-a' : 'note-b', body: fromA ? 'from runtime A' : 'from runtime B' }],
        plans: [],
        memory: { global: 0, project: 0 },
      });
    });

    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
    const first = await fetchSessionKnowledgeSummary(directory, 'session-1');
    expect(first.notes.map((note) => note.id)).toEqual(['note-a']);
    expect(calls).toBe(1);

    // Same runtime, inside the freshness window: the cached promise serves.
    const again = await fetchSessionKnowledgeSummary(directory, 'session-1');
    expect(again.notes.map((note) => note.id)).toEqual(['note-a']);
    expect(calls).toBe(1);

    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    const afterSwitch = await fetchSessionKnowledgeSummary(directory, 'session-1');
    expect(afterSwitch.notes.map((note) => note.id)).toEqual(['note-b']);
    expect(calls).toBe(2);
  });
});
