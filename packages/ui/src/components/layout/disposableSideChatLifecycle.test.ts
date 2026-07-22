import { describe, expect, test } from 'bun:test';
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2';

import {
  closeDisposableSideChat,
  hasActiveDisposableSideChatWork,
  promoteDisposableSideChat,
  serializeDisposableSideChatSend,
  waitForDisposableSideChatToSettle,
  type DisposableSideChatIdentity,
} from './disposableSideChatLifecycle';

const identity: DisposableSideChatIdentity = {
  runtimeKey: 'runtime-a',
  directory: '/repo',
  parentSessionId: 'parent-1',
  sideSessionId: 'side-1',
};

describe('disposable side chat lifecycle', () => {
  test('treats busy, retry, permission, and question state as active work', () => {
    expect(hasActiveDisposableSideChatWork({ status: { type: 'busy' }, permissionCount: 0, questionCount: 0 })).toBe(true);
    expect(hasActiveDisposableSideChatWork({ status: { type: 'retry' } as SessionStatus, permissionCount: 0, questionCount: 0 })).toBe(true);
    expect(hasActiveDisposableSideChatWork({ status: { type: 'idle' }, permissionCount: 1, questionCount: 0 })).toBe(true);
    expect(hasActiveDisposableSideChatWork({ status: { type: 'idle' }, permissionCount: 0, questionCount: 1 })).toBe(true);
    expect(hasActiveDisposableSideChatWork({ status: { type: 'idle' }, permissionCount: 0, questionCount: 0 })).toBe(false);
  });

  test('waits for authoritative busy state to settle without requiring prompts to disappear', async () => {
    let busy = true;
    queueMicrotask(() => { busy = false; });
    expect(await waitForDisposableSideChatToSettle(() => busy, 250)).toBe(true);
  });

  test('aborts active work before canonical deletion and closes only after success', async () => {
    const calls: string[] = [];
    const result = await closeDisposableSideChat(identity, {
      isActive: () => true,
      abort: async () => { calls.push('abort'); },
      waitUntilSettled: async () => { calls.push('settled'); return true; },
      deleteSession: async () => { calls.push('delete'); return true; },
      complete: () => { calls.push('complete'); },
      closeTab: () => { calls.push('close'); },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['abort', 'settled', 'delete', 'complete', 'close']);
  });

  test('retains ownership and the panel when deletion fails', async () => {
    const calls: string[] = [];
    const result = await closeDisposableSideChat(identity, {
      isActive: () => false,
      abort: async () => { calls.push('abort'); },
      waitUntilSettled: async () => true,
      deleteSession: async () => false,
      complete: () => { calls.push('complete'); },
      closeTab: () => { calls.push('close'); },
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test('publishes promotion before clearing ownership, closing, and navigation', async () => {
    const calls: string[] = [];
    const result = await promoteDisposableSideChat(identity, {
      promote: async () => { calls.push('promote'); return { id: identity.sideSessionId } as Session; },
      publish: () => { calls.push('publish'); },
      complete: () => { calls.push('complete'); },
      closeTab: () => { calls.push('close'); },
      navigate: async () => { calls.push('navigate'); },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['promote', 'publish', 'complete', 'close', 'navigate']);
  });

  test('keeps destructive calls bound to the captured runtime when the visible runtime switches', async () => {
    const calls: string[] = [];
    const result = await closeDisposableSideChat(identity, {
      isActive: () => true,
      abort: async () => { calls.push('abort:capture-a'); },
      waitUntilSettled: async () => { calls.push('settled'); return true; },
      deleteSession: async () => { calls.push('delete'); return true; },
      complete: () => { calls.push('complete'); },
      closeTab: () => { calls.push('close'); },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['abort:capture-a', 'settled', 'delete', 'complete', 'close']);
  });

  test('serializes simultaneous close operations for one side chat', async () => {
    let deletes = 0;
    const dependencies = {
      isActive: () => false,
      abort: async () => {},
      waitUntilSettled: async () => true,
      deleteSession: async () => { deletes += 1; await Promise.resolve(); return true; },
      complete: () => {},
      closeTab: () => {},
    };
    const [first, second] = await Promise.all([
      closeDisposableSideChat(identity, dependencies),
      closeDisposableSideChat(identity, dependencies),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(deletes).toBe(1);
  });

  test('does not let close overtake an initial send for the same side chat', async () => {
    const calls: string[] = [];
    let releaseSend!: () => void;
    const send = serializeDisposableSideChatSend(identity, async () => {
      calls.push('send:start');
      await new Promise<void>((resolve) => { releaseSend = resolve; });
      calls.push('send:end');
    });
    await Promise.resolve();
    const close = closeDisposableSideChat(identity, {
      isActive: () => true,
      abort: async () => { calls.push('abort'); },
      waitUntilSettled: async () => true,
      deleteSession: async () => { calls.push('delete'); return true; },
      complete: () => {},
      closeTab: () => {},
    });
    await Promise.resolve();
    expect(calls).toEqual(['send:start']);
    releaseSend();
    await Promise.all([send, close]);
    expect(calls).toEqual(['send:start', 'send:end', 'abort', 'delete']);
  });

});
