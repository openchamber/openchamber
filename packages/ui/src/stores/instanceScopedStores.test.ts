import { beforeEach, describe, expect, test } from 'bun:test';
import type { McpServerStatus } from '@/lib/opencode/model';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const environment = directoryEnvironment({ home: '/home/test' });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

let mcpStatusResponse: Deferred<McpServerStatus[]> = deferred();
let skillsResponse: Deferred<Response> = deferred();
let mcpStarted = deferred<void>();
let skillsStarted = deferred<void>();
environment.respond(async (url) => {
  if (url.pathname === '/api/mcp') {
    mcpStarted.resolve();
    return Response.json({ data: await mcpStatusResponse.promise });
  }
  if (url.pathname === '/api/config/skills') {
    skillsStarted.resolve();
    return skillsResponse.promise;
  }
  if (url.pathname === '/api/config') return Response.json([]);
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  throw new Error(`Unexpected request: ${url}`);
});

const { useMcpStore } = await import('./useMcpStore');
const { useSkillsStore } = await import('./useSkillsStore');

const connectedServer = (name: string): McpServerStatus[] => ([
  { name, status: { status: 'connected' } },
]);

describe('instance-scoped stores reject responses from the previous instance', () => {
  beforeEach(() => {
    mcpStatusResponse = deferred();
    skillsResponse = deferred();
    mcpStarted = deferred();
    skillsStarted = deferred();
    useMcpStore.getState().resetForRuntimeSwitch();
    useSkillsStore.getState().resetForRuntimeSwitch();
  });

  test('an MCP status in flight during a switch does not land in the new instance', async () => {
    const refresh = useMcpStore.getState().refresh({ directory: '/repo', silent: true });
    await mcpStarted.promise;

    useMcpStore.getState().resetForRuntimeSwitch();
    mcpStatusResponse.resolve(connectedServer('from-instance-a'));
    await refresh;

    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
  });

  test('an MCP status that arrives with no switch is stored', async () => {
    const refresh = useMcpStore.getState().refresh({ directory: '/repo', silent: true });
    await mcpStarted.promise;
    mcpStatusResponse.resolve(connectedServer('server-a'));
    await refresh;

    expect(Object.keys(useMcpStore.getState().getStatusForDirectory('/repo'))).toEqual(['server-a']);
  });

  test('a skills load in flight during a switch does not land in the new instance', async () => {
    const load = useSkillsStore.getState().loadSkills('/repo');
    await skillsStarted.promise;

    useSkillsStore.getState().resetForRuntimeSwitch();
    skillsResponse.resolve(new Response(
      JSON.stringify({ skills: [{ name: 'from-instance-a', path: '/repo/.agents/skills/a/SKILL.md' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await load;

    expect(useSkillsStore.getState().skillsByDirectory['/repo']).toBe(undefined);
  });
});
