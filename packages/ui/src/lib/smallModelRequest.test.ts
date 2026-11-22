import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ToastCall = { title: string; options: { id?: string; description?: string; action?: { label: string } } };

let toastCalls: ToastCall[] = [];
let nextResponse: () => Promise<Response> = async () => new Response('{}');
const openedSettings: string[][] = [];

mock.module('sonner', () => ({
  toast: {
    error: (title: string, options: ToastCall['options']) => { toastCalls.push({ title, options }); },
  },
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: () => nextResponse(),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: { getState: () => ({ openSettingsAt: (...args: string[]) => { openedSettings.push(args); } }) },
}));

const { requestSmallModel } = await import('./smallModelRequest');

const json = (status: number, body: Record<string, string>): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const TRUST_MESSAGE = 'OpenCode is paused for /repo. Open the folder in OpenChamber and trust its configuration before trying again.';
const trustRefusal = (): Response => json(403, { error: TRUST_MESSAGE, code: 'opencode_trust_required', directory: '/repo' });

describe('requestSmallModel', () => {
  beforeEach(() => {
    toastCalls = [];
    openedSettings.length = 0;
  });

  test('a folder-trust refusal shows the folder instructions without the model-settings action', async () => {
    nextResponse = async () => trustRefusal();

    const response = await requestSmallModel({ method: 'POST' });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].title).toBe(TRUST_MESSAGE);
    expect(toastCalls[0].options.action).toBeUndefined();
    expect(toastCalls[0].options.id).not.toBe('small-model-unavailable');
    // The caller can still read the refusal itself.
    expect(await response.json()).toEqual({ error: TRUST_MESSAGE, code: 'opencode_trust_required', directory: '/repo' });
  });

  test('a refusal without a message names the folder', async () => {
    nextResponse = async () => json(403, { code: 'opencode_trust_required', directory: '/repo' });

    await requestSmallModel({ method: 'POST' });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].title).toContain('/repo');
    expect(toastCalls[0].options.action).toBeUndefined();
  });

  test('an unrelated 403 keeps the Small Model advice', async () => {
    nextResponse = async () => json(403, { error: 'Forbidden' });

    await requestSmallModel({ method: 'POST' });

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].options.id).toBe('small-model-unavailable');
    expect(toastCalls[0].options.action).toBeDefined();
  });

  test('a server error keeps the Small Model advice', async () => {
    nextResponse = async () => json(500, { error: 'boom' });

    await requestSmallModel({ method: 'POST' });

    expect(toastCalls.map((call) => call.options.id)).toEqual(['small-model-unavailable']);
  });

  test('notifyOnError: false stays silent for a trust refusal and leaves the body readable', async () => {
    nextResponse = async () => trustRefusal();

    const response = await requestSmallModel({ method: 'POST' }, { notifyOnError: false });

    expect(toastCalls).toHaveLength(0);
    expect((await response.json()).code).toBe('opencode_trust_required');
  });

  test('a silenced status stays silent, trust refusal included', async () => {
    nextResponse = async () => trustRefusal();
    await requestSmallModel({ method: 'POST' }, { silentStatuses: [403] });
    nextResponse = async () => json(404, { error: 'No small model' });
    await requestSmallModel({ method: 'POST' }, { silentStatuses: [404] });

    expect(toastCalls).toHaveLength(0);
  });

  test('a network failure keeps the Small Model advice and rethrows', async () => {
    nextResponse = async () => { throw new Error('offline'); };

    await expect(requestSmallModel({ method: 'POST' })).rejects.toThrow('offline');
    expect(toastCalls.map((call) => call.options.id)).toEqual(['small-model-unavailable']);
  });
});
