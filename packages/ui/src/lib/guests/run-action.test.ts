import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { GUEST_REQUEST_TIMEOUT_MS, type GuestMessageItem } from '@openchamber/sdk';
import { toast } from 'sonner';
import { Window } from 'happy-dom';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import type { GuestActionEntry } from './actions';
import { useGuestDialogStore } from './dialog-store';
import { useGuestItemStore } from './item-store';
import { parseGuestCatalogJson } from './parse';
import { runGuestAction, useGuestActionHostStore } from './run-action';
import { useGuestsStore } from './store';
import { runGuestSessionAction } from './session-action';
import type { SessionMessageRecord } from '@/lib/exportSession';

const item: GuestMessageItem = { kind: 'message', action: 'count', sessionId: 's1', sessionTitle: 'Session', directory: '/repo', messageId: 'm1', role: 'assistant', text: 'Hello' };
const entry: GuestActionEntry = {
  guest: { id: 'counter', name: 'Counter', icon: 'window', entry: 'panel/index.html', attach: 'dialog', capabilities: { requested: [], granted: [] }, actions: [{ id: 'count', label: 'Count', where: 'message', mode: 'background' }] },
  action: { id: 'count', label: 'Count', where: 'message', mode: 'background' },
  icon: 'window',
};
const t: Parameters<typeof runGuestAction>[2] = (key) => key;

const currentRequest = () => {
  const request = useGuestActionHostStore.getState().requests[0];
  if (!request) throw new Error('Expected a background action');
  return request;
};

describe('guest action execution', () => {
  let errors: ReturnType<typeof spyOn<typeof toast, 'error'>>;
  beforeEach(() => {
    const runtime = getRuntimeKey();
    useGuestsStore.getState().resetForRuntimeSwitch(runtime);
    useGuestsStore.getState().replaceCatalog([structuredClone(entry.guest)], runtime);
    useGuestDialogStore.getState().close();
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    errors = spyOn(toast, 'error').mockImplementation(() => 'error-toast');
  });
  afterEach(() => {
    for (const request of useGuestActionHostStore.getState().requests) request.complete({ ok: true });
    errors.mockRestore();
  });

  test('catalog round-trip retains the execution mode', () => {
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [entry.guest] }))?.[0]?.actions).toEqual([entry.action]);
    expect(parseGuestCatalogJson(JSON.stringify({ guests: [{ ...entry.guest, actions: [{ ...entry.action, mode: 'invalid' }] }] }))).toBeNull();
  });

  test('background actions deliver the captured item once and preserve visible surfaces', async () => {
    const ui = useUIStore.getState();
    const pending = runGuestAction(entry, item, t);
    const request = currentRequest();
    expect(request.takeMessage()).toMatchObject({ type: 'action', payload: item });
    expect(request.takeMessage()).toBeNull();
    expect(request.item).not.toBe(item);
    expect(useGuestDialogStore.getState().request).toBeNull();
    expect(useGuestItemStore.getState().pendingItemByGuest).toEqual({});
    expect(useUIStore.getState()).toBe(ui);
    request.complete({ ok: true });
    await pending;
    expect(request.isActive()).toBe(false);
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
    expect(errors.mock.calls.length).toBe(0);
  });

  test('overlapping clicks keep separate items and completion lifetimes', async () => {
    const first = runGuestAction(entry, item, t);
    const firstRequest = currentRequest();
    const second = runGuestAction(entry, { ...item, messageId: 'm2' }, t);
    firstRequest.complete({ ok: true });
    await first;
    expect(currentRequest().item).toMatchObject({ messageId: 'm2' });
    currentRequest().complete({ ok: false, error: 'Could not count' });
    await second;
    expect(errors.mock.calls.length).toBe(1);
    expect(errors.mock.calls[0]?.[1]).toMatchObject({ description: 'Could not count' });
    firstRequest.complete({ ok: false, error: 'late' });
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
  });

  test('legacy actions still open the declared dialog', async () => {
    const action = { ...entry.action, mode: undefined };
    const legacy = { ...entry, action, guest: { ...entry.guest, actions: [action] } };
    useGuestsStore.getState().replaceCatalog([legacy.guest], getRuntimeKey());
    await runGuestAction(legacy, item, t);
    expect(useGuestDialogStore.getState().request).toEqual({ guestId: entry.guest.id, item });
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
  });

  test('a background-only action is invalidated when its execution entry changes', async () => {
    const background = { ...entry, guest: { ...entry.guest, entry: undefined, attach: undefined, backgroundEntry: 'background.html' } };
    useGuestsStore.getState().replaceCatalog([background.guest], getRuntimeKey());
    const pending = runGuestAction(background, item, t);
    const request = currentRequest();
    expect(request.isActive()).toBe(true);
    useGuestsStore.getState().replaceCatalog([{ ...background.guest, backgroundEntry: 'updated.html' }], getRuntimeKey());
    expect(request.isActive()).toBe(false);
    expect(request.takeMessage()).toBeNull();
    await pending;
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
  });

  test('disabled, unapproved, undeclared and wrong-role actions never mount', async () => {
    for (const guest of [
      { ...entry.guest, enabled: false },
      { ...entry.guest, capabilities: { requested: ['files'] as const, granted: [] } },
      { ...entry.guest, actions: [] },
      { ...entry.guest, actions: [{ ...entry.action, roles: ['user'] as const }] },
    ]) {
      const parsed = parseGuestCatalogJson(JSON.stringify({ guests: [guest] }));
      if (!parsed) throw new Error('Invalid fixture');
      useGuestsStore.getState().replaceCatalog(parsed, getRuntimeKey());
      await runGuestAction(entry, item, t);
      expect(useGuestActionHostStore.getState().requests).toEqual([]);
    }
  });

  test('disabling or switching runtimes tears down work and refuses late completion', async () => {
    const first = runGuestAction(entry, item, t);
    const request = currentRequest();
    useGuestsStore.getState().replaceCatalog([{ ...entry.guest, enabled: false }], getRuntimeKey());
    await first;
    expect(request.isActive()).toBe(false);
    expect(request.takeMessage()).toBeNull();
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
    useGuestsStore.getState().replaceCatalog([entry.guest], getRuntimeKey());
    const second = runGuestAction(entry, item, t);
    const secondRequest = currentRequest();
    useGuestsStore.getState().resetForRuntimeSwitch('another-runtime');
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    useGuestsStore.getState().replaceCatalog([entry.guest], getRuntimeKey());
    await second;
    secondRequest.complete({ ok: true });
    expect(secondRequest.takeMessage()).toBeNull();
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
  });

  test('a silent frame times out and releases its execution', async () => {
    await runGuestAction(entry, item, t);
    expect(useGuestActionHostStore.getState().requests).toEqual([]);
    expect(errors.mock.calls.length).toBe(1);
  }, GUEST_REQUEST_TIMEOUT_MS + 5_000);

  test('session actions distinguish failed history from empty history and discard runtime changes during loading', async () => {
    const dom = new Window();
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
    const sessionAction: GuestActionEntry['action'] = { id: 'summary', label: 'Summary', where: 'session', mode: 'background', payload: ['messages'] };
    const sessionEntry: GuestActionEntry = { ...entry, action: sessionAction, guest: { ...entry.guest,
      actions: [sessionAction], capabilities: { requested: ['conversation'], granted: ['conversation'] },
    } };
    let failures = 0;
    const input = { entry: sessionEntry, session: { id: 's1', title: 'Session', directory: '/repo' }, t, onLoadFailed: () => { failures++; } };
    useGuestsStore.getState().replaceCatalog([sessionEntry.guest], getRuntimeKey());
    try {
      await runGuestSessionAction({ ...input, loadRecords: async () => null });
      expect(failures).toBe(1);
      expect(useGuestActionHostStore.getState().requests).toEqual([]);
      const empty = runGuestSessionAction({ ...input, loadRecords: async () => [] });
      await Promise.resolve();
      expect(currentRequest().takeMessage()).toMatchObject({ payload: { kind: 'session', messages: [] } });
      currentRequest().complete({ ok: true });
      await empty;

      let finish: (records: SessionMessageRecord[]) => void = () => {};
      const history = new Promise<SessionMessageRecord[]>((resolve) => { finish = resolve; });
      const stale = runGuestSessionAction({ ...input, loadRecords: () => history });
      dom.dispatchEvent(new dom.CustomEvent('openchamber:runtime-endpoint-changed'));
      finish([]);
      await stale;
      expect(useGuestActionHostStore.getState().requests).toEqual([]);
      expect(failures).toBe(1);
    } finally {
      await dom.happyDOM.close();
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
