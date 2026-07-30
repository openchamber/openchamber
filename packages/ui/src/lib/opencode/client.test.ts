import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: Array<unknown> = [];

const commandResults: Array<unknown> = [];

const promptAsyncMock = mock(async (...args: unknown[]) => {
  promptAsyncCalls.push(args);
  const next = promptAsyncResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { response: new Response(null, { status: 200 }) };
});

const commandMock = mock(async () => {
  const next = commandResults.shift();
  return next ?? { data: true, response: new Response(null, { status: 200 }) };
});

const htmlPage = '<!doctype html><html><body>OpenChamber</body></html>';
const htmlResult = () => ({
  data: htmlPage,
  response: new Response(htmlPage, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    session: {
      promptAsync: promptAsyncMock,
      command: commandMock,
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

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  commandResults.length = 0;
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient prompt retry behavior', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    promptAsyncResults.push({ error: new TypeError('relay tunnel reset: plaintext frame on established channel'), response: undefined });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    promptAsyncResults.push({ response: new Response('starting', { status: 503 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });
});

describe('opencodeClient rejects HTML responses', () => {
  test('a 2xx HTML page fails the prompt because the message never reached OpenCode', async () => {
    promptAsyncResults.push(htmlResult());

    let error: unknown = null;
    try {
      await opencodeClient.sendMessage({
        id: 'ses_1',
        providerID: 'anthropic-html',
        modelID: 'claude-sonnet',
        text: 'hello',
      });
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('returned a web page instead of an API response');
    expect((error as Error & { status?: number }).status).toBe(200);
  });

  test('a 2xx HTML page fails a slash command send', async () => {
    commandResults.push(htmlResult());

    let error: unknown = null;
    try {
      await opencodeClient.sendCommand({
        id: 'ses_1',
        providerID: 'anthropic-html-command',
        modelID: 'claude-sonnet',
        command: 'review',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error ? error.message : String(error)).toContain('returned a web page instead of an API response');
  });

  test('accepts the 204 acknowledgement that a healthy prompt returns', async () => {
    promptAsyncResults.push({ response: new Response(null, { status: 204 }) });

    const messageId = await opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-204',
      modelID: 'claude-sonnet',
      text: 'hello',
      messageId: 'msg_204',
    });

    expect(messageId).toBe('msg_204');
  });

  test('a 2xx HTML page fails config reads instead of caching the page as config', async () => {
    const request = opencodeClient.getConfig('/workspace/html');
    configResolvers.at(-1)?.(htmlResult() as unknown as ConfigResponse);

    await expect(request).rejects.toThrow('returned a web page instead of an API response');
    opencodeClient.clearConfigCache();
  });
});
