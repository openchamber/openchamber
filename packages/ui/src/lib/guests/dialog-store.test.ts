import { afterEach, describe, expect, test } from 'bun:test';

import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { openGuestWithItem, useGuestDialogStore } from './dialog-store';
import { useGuestItemStore } from './item-store';

const item = { kind: 'link', identifier: 'DEMO-2' } as const;
const panelGuest = { id: 'tasks', attach: 'panel' as const };
const shown = (directory: string) => {
  const panel = useUIStore.getState().contextPanelByDirectory[normalizeContextPanelDirectoryKey(directory)];
  return Boolean(panel?.tabs.some((tab) => tab.mode === pluginModeFromId('tasks')));
};

describe('openGuestWithItem', () => {
  afterEach(() => {
    useUIStore.setState({ contextPanelByDirectory: {} });
    useGuestItemStore.setState({ pendingItemByGuest: {} });
    useGuestDialogStore.setState({ request: null });
  });

  test('opens the panel and keeps it open on a second open, handing the item over each time', () => {
    expect(openGuestWithItem(panelGuest, item, '/repo')).toBe(true);
    expect(shown('/repo')).toBe(true);
    expect(useGuestItemStore.getState().takePendingItem('tasks')).toEqual(item);
    expect(openGuestWithItem(panelGuest, item, '/repo')).toBe(true);
    expect(shown('/repo')).toBe(true);
    expect(useGuestItemStore.getState().takePendingItem('tasks')).toEqual(item);
  });

  test('with no folder to open it in, nothing opens and nothing waits for a later rail click', () => {
    expect(openGuestWithItem(panelGuest, item, null)).toBe(false);
    expect(openGuestWithItem(panelGuest, item, '')).toBe(false);
    expect(useGuestItemStore.getState().pendingItemByGuest).toEqual({});
  });

  test('a dialog-mode extension opens its dialog with the item', () => {
    expect(openGuestWithItem({ id: 'tasks', attach: 'dialog' }, item, null)).toBe(true);
    expect(useGuestDialogStore.getState().request).toEqual({ guestId: 'tasks', item });
  });
});
