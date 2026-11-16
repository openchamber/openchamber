import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { connectMobileWorkspaceOpener, type MobileWorkspaceRequest } from '@/lib/mobileWorkspaceTabs';

import { openGuestWithItem, useGuestDialogStore } from './dialog-store';
import { useGuestItemStore } from './item-store';
import { openGuestSurface } from './open-surface';
import { useGuestsStore } from './store';
import type { InstalledGuest } from './types';

const guest = (id: string, overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'apps',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  ...overrides,
});

describe('opening extension frames on the phone', () => {
  let previousWindow: PropertyDescriptor | undefined;
  let requests: MobileWorkspaceRequest[];
  let disconnect: () => void;

  beforeEach(() => {
    // The surface check reads the boot stamp first; the test runs without a DOM.
    previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { __OPENCHAMBER_SURFACE__: 'mobile' } });
    requests = [];
    disconnect = connectMobileWorkspaceOpener((request) => { requests.push(request); });
    useGuestsStore.setState({
      guests: [
        guest('fits', { entryMobile: true }),
        guest('wide'),
        guest('fits-dialog', { entryMobile: true, attach: 'dialog' }),
      ],
    });
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    useGuestDialogStore.setState({ request: null });
  });

  afterEach(() => {
    disconnect();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    useGuestsStore.setState({ guests: [] });
  });

  test('openSurface opens the phone tab that exists and refuses the rest', () => {
    expect(openGuestSurface({ mode: 'plugin:fits', directory: null, supported: true })).toEqual({ ok: true });
    expect(openGuestSurface({ mode: 'diff', directory: '/repo', supported: true })).toEqual({ ok: true });
    expect(openGuestSurface({ mode: 'plugin:wide', directory: '/repo', supported: true })).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(openGuestSurface({ mode: 'browser', directory: '/repo', supported: true })).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(requests).toEqual([{ tab: 'plugin:fits' }, { tab: 'changes' }]);
  });

  test('an item reaches the tab of a guest that opted in, and nothing is parked for one that did not', () => {
    const item = { kind: 'link' as const, identifier: 'DEMO-1' };
    expect(openGuestWithItem({ id: 'fits', attach: undefined }, item, null)).toBe(true);
    expect(useGuestItemStore.getState().pendingItemByGuest.fits).toEqual(item);
    expect(requests).toEqual([{ tab: 'plugin:fits' }]);

    expect(openGuestWithItem({ id: 'wide', attach: undefined }, item, '/repo')).toBe(false);
    expect(useGuestItemStore.getState().pendingItemByGuest.wide).toBeUndefined();

    expect(openGuestWithItem({ id: 'fits-dialog', attach: 'dialog' }, item, null)).toBe(true);
    expect(useGuestDialogStore.getState().request?.guestId).toBe('fits-dialog');
  });

  test('without a mounted shell the item is taken back', () => {
    disconnect();
    expect(openGuestWithItem({ id: 'fits', attach: undefined }, { kind: 'link', identifier: 'DEMO-1' }, null)).toBe(false);
    expect(useGuestItemStore.getState().pendingItemByGuest.fits).toBeUndefined();
  });
});
