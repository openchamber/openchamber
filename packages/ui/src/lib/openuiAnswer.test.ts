import { expect, test } from 'bun:test';
import { answerOpenUI } from './openuiAnswer';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

test('routes an OpenUI answer to its space and leaves host requests unscoped', async () => {
  const previous = getRuntimeUrlResolver();
  const originalFetch = globalThis.fetch;
  const headers: Headers[] = [];
  try {
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    };
    const answer = { sessionId: 's', callId: 'c', summary: 'Yes', data: null, sourceRevision: 'revision' };
    await answerOpenUI(answer, '/spaces/123456789abc/project');
    await answerOpenUI(answer, '/repo');
    expect(headers[0].get('x-opencode-directory')).toBe('%2Fspaces%2F123456789abc%2Fproject');
    expect(headers[0].get('x-opencode-directory-encoding')).toBe('uri');
    expect(headers[1].has('x-opencode-directory')).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimeUrlResolver(previous);
  }
});
