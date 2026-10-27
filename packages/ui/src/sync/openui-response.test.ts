import { afterEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useInputStore } from './input-store';
import { sendOpenUIResponse } from './session-ui-store';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { ChildStoreManager } from './child-store';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('OpenUI submits a normal user turn without consuming the composer draft', async () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://openui.test' });
  globalThis.fetch = async () => Response.json({ ok: true });
  useConfigStore.setState({ currentProviderId: 'provider', isConnected: true, hasEverConnected: true });
  const stores = new ChildStoreManager();
  setActionRefs(stores, () => '/openui');
  useInputStore.getState().setPendingInputText('Keep my draft');
  const inserted: string[] = [];
  setOptimisticRefs(({ message }) => inserted.push(message.id), () => {});
  const send = spyOn(opencodeClient, 'sendMessage').mockResolvedValue('message');
  const command = spyOn(opencodeClient, 'sendCommand');
  try {
    await sendOpenUIResponse({
      runtimeKey: getRuntimeKey(),
      sessionId: 'openui-session',
      directory: '/openui',
      summary: '/this-is-not-a-command',
      data: { selected: 'a' },
      isCurrent: () => true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(command).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].text).toContain('/this-is-not-a-command');
    expect(send.mock.calls[0][0].text).toContain('"selected":"a"');
    expect(send.mock.calls[0][0].model).toBeUndefined();
    expect(send.mock.calls[0][0].agent).toBeUndefined();
    expect(useInputStore.getState().pendingInputText).toBe('Keep my draft');
  } finally {
    send.mockRestore();
    command.mockRestore();
  }
});

test('a stale runtime cannot deliver an OpenUI answer', async () => {
  const send = spyOn(opencodeClient, 'sendMessage');
  try {
    await expect(sendOpenUIResponse({
      runtimeKey: 'retired-runtime', sessionId: 'session', directory: '/openui',
      summary: 'Choose A', data: null,
      isCurrent: () => true,
    })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
  }
});

test('source revocation during instruction sync rolls back without delivering an answer', async () => {
  let finishKnowledge: ((value: Response) => void) | undefined;
  let current = true;
  let requested: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const knowledge = new Promise<Response>((resolve) => { finishKnowledge = resolve; });
  globalThis.fetch = async () => { requested?.(); return knowledge; };
  useConfigStore.setState({ currentProviderId: 'provider', isConnected: true, hasEverConnected: true });
  const stores = new ChildStoreManager();
  setActionRefs(stores, () => '/openui');
  const inserted: string[] = [];
  const removed: string[] = [];
  setOptimisticRefs(({ message }) => inserted.push(message.id), ({ messageID }) => removed.push(messageID));
  const send = spyOn(opencodeClient, 'sendMessage');
  try {
    const submission = sendOpenUIResponse({
      runtimeKey: getRuntimeKey(), sessionId: 'syncing', directory: '/openui',
      summary: 'Choose A', data: null, isCurrent: () => current,
    });
    await started;
    current = false;
    finishKnowledge?.(Response.json({ ok: true }));
    await expect(submission).rejects.toThrow('interface changed');
    expect(send).not.toHaveBeenCalled();
    expect(removed).toEqual(inserted);
  } finally {
    send.mockRestore();
  }
});
