import { describe, expect, test } from 'bun:test';
import type { GuestRequest, GuestStatusView } from '@openchamber/sdk';

import type { GuestRequestProxyResult } from './oauth';
import {
  createGuestStatusViewReader,
  startStatusViewPolling,
  type GuestStatusViewRead,
  type StatusViewVisibility,
} from './status-view';

const view = (cpu: string): GuestStatusView => ({
  rows: [
    { kind: 'line', id: 'app', label: 'OpenChamber', value: '1.6 GB' },
    { kind: 'line', id: 'cpu', label: 'CPU', value: cpu },
  ],
});

const answering = (bodies: string[]) => {
  const requests: Array<{ guestId: string; request: GuestRequest }> = [];
  const read = async (guestId: string, request: GuestRequest): Promise<GuestRequestProxyResult> => {
    requests.push({ guestId, request });
    const body = bodies.shift();
    if (body === undefined) return { ok: false, code: 'SERVICE_FAILED', message: 'down' };
    return { ok: true, result: { status: 200, body } };
  };
  return { read, requests };
};

describe('createGuestStatusViewReader', () => {
  test('asks the source path with the panel directory and keeps unchanged rows', async () => {
    const service = answering([JSON.stringify(view('10%')), JSON.stringify(view('10%')), JSON.stringify(view('25%'))]);
    const reader = createGuestStatusViewReader('monitor', '/status', { directory: '/repo', locale: 'de' }, service.read);
    const first = await reader();
    const same = await reader();
    const next = await reader();
    expect(service.requests[0]).toEqual({ guestId: 'monitor', request: { method: 'GET', path: '/status', query: { directory: '/repo', locale: 'de' } } });
    if (!first.ok || !same.ok || !next.ok) throw new Error('expected three views');
    expect(same.view).toBe(first.view);
    expect(next.view).not.toBe(first.view);
    expect(next.view.rows[0]).toBe(first.view.rows[0]);
    expect(next.view.rows[1]).not.toBe(first.view.rows[1]);
  });

  test('keeps the header controls while they do not change', async () => {
    const withControls = (cpu: string) => JSON.stringify({ ...view(cpu), controls: [{ kind: 'button', id: 'refresh', label: 'Refresh' }] });
    const reader = createGuestStatusViewReader('monitor', '/status', { directory: null, locale: 'en' }, answering([withControls('1%'), withControls('2%')]).read);
    const first = await reader();
    const next = await reader();
    if (!first.ok || !next.ok) throw new Error('expected two views');
    expect(next.view).not.toBe(first.view);
    expect(next.view.controls).toBe(first.view.controls);
  });

  test('tells a service that did not answer from an answer it cannot draw', async () => {
    const reader = createGuestStatusViewReader('monitor', '/status', { directory: null, locale: 'en' }, answering(['{"rows":[{"kind":"chart"}]}', 'not json']).read);
    expect(await reader()).toEqual({ ok: false, failure: 'invalid' });
    expect(await reader()).toEqual({ ok: false, failure: 'invalid' });
    expect(await reader()).toEqual({ ok: false, failure: 'unreachable' });
  });
});

const clock = () => {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let next = 1;
  return {
    schedule: (callback: () => void, delay: number) => {
      const id = next++;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel: (id: number) => { timers.delete(id); },
    pending: () => [...timers.values()].map((timer) => timer.delay),
    fire: () => {
      const [id, timer] = [...timers.entries()][0] ?? [];
      if (id === undefined || !timer) throw new Error('no timer');
      timers.delete(id);
      timer.callback();
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const visibilitySwitch = () => {
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibility: StatusViewVisibility = {
    isHidden: () => hidden,
    onVisible: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    visibility,
    hide: () => { hidden = true; },
    show: () => {
      hidden = false;
      for (const listener of listeners) listener();
    },
  };
};

describe('startStatusViewPolling', () => {
  const ok: GuestStatusViewRead = { ok: true, view: view('1%') };

  test('reads at once, then an interval after each read finishes', async () => {
    const time = clock();
    let reads = 0;
    const poller = startStatusViewPolling({
      read: async () => { reads += 1; return ok; }, interval: 2000, onRead: () => undefined,
      visibility: visibilitySwitch().visibility, schedule: time.schedule, cancel: time.cancel,
    });
    await settle();
    expect(reads).toBe(1);
    expect(time.pending()).toEqual([2000]);
    time.fire();
    await settle();
    expect(reads).toBe(2);
    poller.stop();
    expect(time.pending()).toEqual([]);
  });

  test('a refresh during a read reads once more right after it', async () => {
    const time = clock();
    let reads = 0;
    let release: () => void = () => undefined;
    const poller = startStatusViewPolling({
      read: () => {
        reads += 1;
        return new Promise((resolve) => { release = () => resolve(ok); });
      },
      interval: 2000, onRead: () => undefined,
      visibility: visibilitySwitch().visibility, schedule: time.schedule, cancel: time.cancel,
    });
    poller.refresh();
    poller.refresh();
    release();
    await settle();
    expect(reads).toBe(2);
    poller.stop();
  });

  test('a refresh resolves only after a read that started after it was delivered', async () => {
    const time = clock();
    const delivered: number[] = [];
    const releases: Array<() => void> = [];
    let reads = 0;
    const poller = startStatusViewPolling({
      read: () => {
        reads += 1;
        const number = reads;
        return new Promise((resolve) => { releases.push(() => resolve({ ok: true, view: view(`${number}%`) })); });
      },
      interval: 2000,
      onRead: (result) => { if (result.ok) delivered.push(Number.parseInt(result.view.rows[1]?.kind === 'line' ? result.view.rows[1].value ?? '' : '', 10)); },
      visibility: visibilitySwitch().visibility, schedule: time.schedule, cancel: time.cancel,
    });
    let fresh = false;
    void poller.refresh().then(() => { fresh = true; });
    releases[0]?.();
    await settle();
    expect(delivered).toEqual([1]);
    expect(fresh).toBe(false);
    releases[1]?.();
    await settle();
    expect(delivered).toEqual([1, 2]);
    expect(fresh).toBe(true);
    poller.stop();
  });

  test('reads nothing while hidden and catches up when shown', async () => {
    const time = clock();
    const screen = visibilitySwitch();
    let reads = 0;
    const poller = startStatusViewPolling({
      read: async () => { reads += 1; return ok; }, interval: 2000, onRead: () => undefined,
      visibility: screen.visibility, schedule: time.schedule, cancel: time.cancel,
    });
    await settle();
    screen.hide();
    time.fire();
    await settle();
    expect(reads).toBe(1);
    expect(time.pending()).toEqual([]);
    screen.show();
    await settle();
    expect(reads).toBe(2);
    poller.stop();
  });

  test('drops an answer that arrives after stop', async () => {
    const time = clock();
    const seen: GuestStatusViewRead[] = [];
    let release: () => void = () => undefined;
    const poller = startStatusViewPolling({
      read: () => new Promise((resolve) => { release = () => resolve(ok); }),
      interval: 2000, onRead: (result) => seen.push(result),
      visibility: visibilitySwitch().visibility, schedule: time.schedule, cancel: time.cancel,
    });
    poller.stop();
    release();
    await settle();
    expect(seen).toEqual([]);
    expect(time.pending()).toEqual([]);
  });
});
