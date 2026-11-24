import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const toasts: string[] = [];
mock.module('@/components/ui', () => ({ toast: { info: (message: string) => { toasts.push(message); } } }));

const { runGuestLink } = await import('./guestLinkClick');
const { useGuestsStore } = await import('@/lib/guests/store');
const { useInputStore } = await import('@/sync/input-store');
const { useGuestScopeStore } = await import('@/lib/guests/folders');
const { useGuestItemStore } = await import('@/lib/guests/item-store');
const { useUIStore } = await import('@/stores/useUIStore');
const { markMiniChatWindow } = await import('@/lib/miniChatWindow');
import type { InstalledGuest } from '@/lib/guests/types';

const panelGuest: InstalledGuest = { id: 'tasks', name: 'Tasks', icon: 'task', attach: 'panel', capabilities: { requested: ['links'], granted: ['links'] } };
const t = (key: string) => key;

beforeEach(() => {
  toasts.length = 0;
  useGuestsStore.setState({ guests: [panelGuest] });
});
afterEach(() => {
  useInputStore.setState({ pendingGuestIssue: null });
  useGuestScopeStore.setState({ paths: [] });
});

test('with no project for the panel, a clicked link keeps its usual meaning and an identifier says why', () => {
  const claim = { guestId: 'tasks', action: 'open' as const, identifier: 'DEMO-1', url: 'https://tasks.example.com/tasks/DEMO-1' };
  expect(runGuestLink(claim, 'link', '', t)).toBe(false);
  expect(toasts).toEqual([]);
  expect(runGuestLink(claim, 'identifier', '', t)).toBe(true);
  expect(toasts).toEqual(['chat.guestLink.noProject']);
});

test('an extension that is no longer granted links takes no click', () => {
  useGuestsStore.setState({ guests: [{ ...panelGuest, capabilities: { requested: ['links'], granted: [] } }] });
  expect(runGuestLink({ guestId: 'tasks', action: 'open', identifier: 'DEMO-1' }, 'identifier', '/repo', t)).toBe(false);
});

test('a chip is built the way an extension\'s own attach is', () => {
  expect(runGuestLink({ guestId: 'tasks', action: 'attach', identifier: 'DEMO-1', url: ' https://tasks.example.com/tasks/DEMO-1 ' }, 'identifier', '/repo', t)).toBe(true);
  expect(useInputStore.getState().pendingGuestIssue).toEqual({ providerId: 'tasks', id: 'DEMO-1', title: 'DEMO-1', url: 'https://tasks.example.com/tasks/DEMO-1', kind: 'issue' });
});

const hiddenPanelLeavesNothing = (panelsBefore: ReturnType<typeof useUIStore.getState>['contextPanelByDirectory']) => {
  expect(useGuestItemStore.getState().pendingItemByGuest.tasks).toBeUndefined();
  expect(useUIStore.getState().contextPanelByDirectory).toBe(panelsBefore);
};

test('a panel limited to another project leaves a clicked link to the browser and explains an identifier, opening no hidden tab', () => {
  const claim = { guestId: 'tasks', action: 'open' as const, identifier: 'DEMO-1' };
  const panelsBefore = useUIStore.getState().contextPanelByDirectory;
  useGuestsStore.setState({ guests: [{ ...panelGuest, folders: ['/other'] }] });
  useGuestScopeStore.setState({ paths: ['/repo'] });
  expect(runGuestLink(claim, 'link', '/repo', t)).toBe(false);
  expect(runGuestLink(claim, 'identifier', '/repo', t)).toBe(true);
  expect(toasts).toEqual(['chat.guestLink.otherProject']);
  hiddenPanelLeavesNothing(panelsBefore);
});

// Last: the mini chat mark lasts for the rest of this file.
test('the mini chat has no panel, so a clicked link stays with the browser and an identifier explains', () => {
  const claim = { guestId: 'tasks', action: 'open' as const, identifier: 'DEMO-1' };
  const panelsBefore = useUIStore.getState().contextPanelByDirectory;
  markMiniChatWindow();
  expect(runGuestLink(claim, 'link', '/repo', t)).toBe(false);
  expect(runGuestLink(claim, 'identifier', '/repo', t)).toBe(true);
  expect(toasts).toEqual(['chat.guestLink.miniChat']);
  hiddenPanelLeavesNothing(panelsBefore);
});
