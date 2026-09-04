import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import type { McpStatusMap } from './useMcpStore';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

type McpStatusResult = Awaited<ReturnType<ReturnType<typeof opencodeModule.opencodeClient.getApiClient>['mcp']['status']>>;
let mcpStatusResponse: Deferred<McpStatusResult> = deferred();
const opencodeModule = await import('@/lib/opencode/client');
// Derived from the real client rather than spread from it: the client is a
// class instance, so a spread drops every prototype method the other modules
// loaded in this process call at import time.
// SAFETY: `Object.create` returns `any`; the object delegates to the real
// client for everything the two overrides below do not define.
const opencodeClientStub = Object.create(opencodeModule.opencodeClient) as typeof opencodeModule.opencodeClient;
// The SDK client is derived the same way, so only `mcp.status` is replaced and
// every other endpoint keeps its real implementation and type.
type McpApiClient = ReturnType<typeof opencodeModule.opencodeClient.getApiClient>;
const realApiClient = opencodeModule.opencodeClient.getApiClient();
const mcpApiStub: McpApiClient = Object.create(realApiClient, {
  mcp: { value: { ...realApiClient.mcp, status: () => mcpStatusResponse.promise } },
});
opencodeClientStub.getApiClient = () => mcpApiStub;
opencodeClientStub.getScopedApiClient = () => mcpApiStub;
mock.module('@/lib/opencode/client', () => ({ ...opencodeModule, opencodeClient: opencodeClientStub }));

let skillsResponse: Deferred<Response> = deferred();
const runtimeFetchModule = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
  runtimeFetch: () => skillsResponse.promise,
}));

const { useMcpStore } = await import('./useMcpStore');
const { useSkillsStore } = await import('./useSkillsStore');

const mcpStatusResult = (data: McpStatusMap): McpStatusResult => ({
  data,
  request: new Request('http://localhost/mcp'),
  response: new Response(),
});

const connectedServer = (name: string): McpStatusMap => ({
  // SAFETY: the store only reads `status` off each entry; the SDK type carries
  // fields no consumer in this test path touches.
  [name]: { status: 'connected' } as McpStatus,
});

describe('instance-scoped stores reject responses from the previous instance', () => {
  beforeEach(() => {
    mcpStatusResponse = deferred();
    skillsResponse = deferred();
    useMcpStore.getState().resetForRuntimeSwitch();
    useSkillsStore.getState().resetForRuntimeSwitch();
  });

  test('an MCP status in flight during a switch does not land in the new instance', async () => {
    const refresh = useMcpStore.getState().refresh({ directory: '/repo', silent: true });

    useMcpStore.getState().resetForRuntimeSwitch();
    mcpStatusResponse.resolve(mcpStatusResult(connectedServer('from-instance-a')));
    await refresh;

    expect(useMcpStore.getState().getStatusForDirectory('/repo')).toEqual({});
  });

  test('an MCP status that arrives with no switch is stored', async () => {
    const refresh = useMcpStore.getState().refresh({ directory: '/repo', silent: true });
    mcpStatusResponse.resolve(mcpStatusResult(connectedServer('server-a')));
    await refresh;

    expect(Object.keys(useMcpStore.getState().getStatusForDirectory('/repo'))).toEqual(['server-a']);
  });

  test('a skills load in flight during a switch does not land in the new instance', async () => {
    const load = useSkillsStore.getState().loadSkills('/repo');

    useSkillsStore.getState().resetForRuntimeSwitch();
    skillsResponse.resolve(new Response(
      JSON.stringify({ skills: [{ name: 'from-instance-a', path: '/repo/.agents/skills/a/SKILL.md' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await load;

    expect(useSkillsStore.getState().skillsByDirectory['/repo']).toBe(undefined);
  });
});
