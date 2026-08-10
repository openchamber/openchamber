import { describe, expect, mock, test } from 'bun:test';

(mock as unknown as { restore?: () => void }).restore?.();

const toolListCalls: unknown[][] = [];
const toolListResults: Array<unknown> = [];

const toolListMock = mock(async (...args: unknown[]) => {
  toolListCalls.push(args);
  const next = toolListResults.shift();
  if (next instanceof Error) throw next;
  return next;
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    tool: {
      list: toolListMock,
    },
  })),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test-listTools=${Date.now()}`);

describe('opencodeClient.listTools', () => {
  test('returns tool schemas from the SDK', async () => {
    toolListResults.push({ data: [{ id: 'bash', description: 'Run', parameters: { type: 'object' } }] });

    const tools = await opencodeClient.listTools('p', 'm', '/repo');

    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe('bash');
    expect(tools[0]!.description).toBe('Run');
    expect(tools[0]!.parameters).toEqual({ type: 'object' });
    expect(toolListCalls[0]![0]).toEqual({ provider: 'p', model: 'm', directory: '/repo' });
  });

  test('omits directory when not provided and no current directory', async () => {
    toolListResults.push({ data: [] });

    await opencodeClient.listTools('p', 'm');

    expect(toolListCalls[1]![0]).toEqual({ provider: 'p', model: 'm' });
  });

  test('filters out entries without a string id', async () => {
    toolListResults.push({
      data: [
        { id: 'bash', description: 'Run', parameters: {} },
        { description: 'missing id', parameters: {} },
        null,
      ],
    });

    const tools = await opencodeClient.listTools('p', 'm');

    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe('bash');
  });

  test('returns [] on SDK failure', async () => {
    toolListResults.push(new Error('down'));

    expect(await opencodeClient.listTools('p', 'm')).toEqual([]);
  });

  test('returns [] when SDK result has no data', async () => {
    toolListResults.push({});

    expect(await opencodeClient.listTools('p', 'm')).toEqual([]);
  });
});
