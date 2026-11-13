import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { setSessionProjectContextPin, syncSessionKnowledge } from './sessionKnowledgeApi';
import { opencodeClient } from './opencode/client';

const SPACE_DIRECTORY = '/spaces/a1b2c3d4e5f6/repo';

let request: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;
let requestBodies: unknown[] = [];

const capturePaths = (): string[] => {
  const paths: string[] = [];
  request = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    // The path and the directory header together say where the request goes.
    const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://app.test').pathname;
    if (pathname === '/api/config/settings') {
      return Response.json({ responseStyleEnabled: true, responseStylePreset: 'concise' });
    }
    const directory = new Headers(init?.headers).get('x-opencode-directory');
    paths.push(`${pathname} ${directory ?? '-'}`);
    requestBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return Response.json({ recorded: true, pins: { notes: ['note-1'], plans: [] } });
  });
  return paths;
};

afterEach(() => {
  request?.mockRestore();
  request = null;
  requestBodies = [];
});

test('VS Code writes, changes and clears the style through the real SDK transport', async () => {
  const originalWindow = globalThis.window;
  const calls: Array<{ url: string; method: string; body: string; directory: string | null }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true, writable: true,
    value: { __VSCODE_CONFIG__: {}, location: { origin: 'https://vscode.test', href: 'https://vscode.test/' } },
  });
  opencodeClient.reconnectToRuntimeBaseUrl();
  request = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, body: await req.text(), directory: req.headers.get('x-opencode-directory') });
    return new Response(null, { status: 204 });
  });
  try {
    await syncSessionKnowledge('/repo', 'session-1', 'First style');
    await syncSessionKnowledge('/repo', 'session-1', 'Second style');
    await syncSessionKnowledge('/repo', 'fusion-judge', 'Judge style');
    await syncSessionKnowledge('/repo', 'session-1', undefined);
    await syncSessionKnowledge('/repo', 'session-1', null);
    expect(calls.map(c => [new URL(c.url).pathname, c.method, c.body, c.directory])).toEqual([
      ['/api/experimental/session/session-1/instructions/entries/openchamber.response-style', 'PUT', JSON.stringify({ value: 'First style' }), '%2Frepo'],
      ['/api/experimental/session/session-1/instructions/entries/openchamber.response-style', 'PUT', JSON.stringify({ value: 'Second style' }), '%2Frepo'],
      ['/api/experimental/session/fusion-judge/instructions/entries/openchamber.response-style', 'PUT', JSON.stringify({ value: 'Judge style' }), '%2Frepo'],
      ['/api/experimental/session/session-1/instructions/entries/openchamber.response-style', 'DELETE', '', '%2Frepo'],
    ]);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
    opencodeClient.reconnectToRuntimeBaseUrl();
  }
});

// The session lives in the space's OpenCode, so a write or pin that reaches
// the host's server finds no session and changes nothing.
describe('session knowledge writes for a session in an isolated space', () => {
  test('the knowledge write reaches the server inside the space', async () => {
    const paths = capturePaths();
    await syncSessionKnowledge(SPACE_DIRECTORY, 'session-1');
    expect(paths).toEqual([`/api/session-knowledge/sync ${encodeURIComponent(SPACE_DIRECTORY)}`]);
  });

  test('sends the response style with the session knowledge', async () => {
    capturePaths();
    await syncSessionKnowledge(SPACE_DIRECTORY, 'session-1', 'Keep replies short.');

    expect(JSON.stringify(requestBodies[0])).toContain('Keep replies short.');
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
