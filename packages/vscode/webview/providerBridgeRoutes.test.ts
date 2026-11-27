import { describe, expect, test } from 'bun:test';
import { handleProviderBridgeRequest } from './providerBridgeRoutes';

type Sent = { type: string; payload: unknown };

const hostAnswering = (answer: () => Promise<{ success: boolean; removed: boolean }>) => {
  const sent: Sent[] = [];
  const send = async <T,>(type: string, payload?: unknown): Promise<T> => {
    sent.push({ type, payload });
    // SAFETY: the route forwards the host's answer as JSON without reading it.
    return await answer() as T;
  };
  return { sent, send };
};

const remove = (query: string, send: ReturnType<typeof hostAnswering>['send']) => {
  const url = new URL(`http://localhost/api/provider/oops%2Dllm/auth?${query}`);
  return handleProviderBridgeRequest(url, url, { method: 'DELETE' }, 'DELETE', send);
};

describe('DELETE /api/provider/:id/auth in VS Code', () => {
  test('asks the extension host to remove the provider from every layer', async () => {
    const host = hostAnswering(async () => ({ success: true, removed: true }));

    const response = await remove('scope=all&directory=%2Fworkspace', host.send);

    expect(host.sent).toEqual([{ type: 'api:provider:remove', payload: { providerId: 'oops-llm', directory: '/workspace' } }]);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ success: true, removed: true });
  });

  test('answers the host refusal as an error the page shows', async () => {
    const host = hostAnswering(async () => { throw new Error('enterprise mode'); });

    const response = await remove('scope=all', host.send);

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: 'enterprise mode' });
  });

  test('refuses the per-layer and credential scopes only the web server has', async () => {
    const host = hostAnswering(async () => ({ success: true, removed: true }));
    for (const query of ['scope=user', 'scope=auth', '']) {
      expect((await remove(query, host.send))?.status).toBe(400);
    }
    expect(host.sent).toEqual([]);
  });
});
