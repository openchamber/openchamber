import { afterEach, describe, expect, test } from 'bun:test';

import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { contextWindowRuntimeKey } from '@/lib/contextWindow/runtime';
import { useContextWindowStore } from '@/lib/contextWindow/store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { guestPanelInstallationKey, guestPanelItemOwner, useGuestItemStore } from './item-store';
import { openDetachedGuestSurface, openGuestSurface } from './open-surface';
import { useGuestsStore } from './store';
import type { InstalledGuest } from './types';

describe('openGuestSurface', () => {
  afterEach(() => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: false, agentWorkflowToolEnabled: false, contextPanelByDirectory: {} });
  });

  for (const [label, flags] of [
    ['without workflows (VS Code)', { agentWorkflowFeatureAvailable: false, agentWorkflowToolEnabled: true }],
    ['with the workflow tool turned off', { agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: false }],
  ] as const) test(`cannot open Workflows ${label}, so an extension never learns it exists`, () => {
    useUIStore.setState(flags);
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({
      ok: false,
      code: 'UNSUPPORTED',
      message: 'That surface cannot open here.',
    });
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
  });

  test('opens Workflows once the workflow tool is on', () => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({ ok: true });
  });

  test('closes an open Workflows tab when the workflow tool is turned off', () => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({ ok: true });
    useUIStore.getState().setAgentWorkflowToolEnabled(false);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.some((tab) => tab.mode === 'workflows')).toBe(false);
  });

  test('selects the requested Project Knowledge tab on an already open panel', () => {
    const previous = useUIStore.getState().projectContextTab;
    const { projects, activeProjectId } = useProjectsStore.getState();
    useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo' }], activeProjectId: 'project' });
    const request = { mode: 'notes', directory: '/repo', supported: true } as const;
    try {
      expect(openGuestSurface({ ...request, options: { tab: 'todos' } })).toEqual({ ok: true });
      expect(useUIStore.getState().projectContextTab).toBe('todos');

      expect(openGuestSurface({ ...request, options: { tab: 'plans' } })).toEqual({ ok: true });
      expect(openGuestSurface(request)).toEqual({ ok: true });
      expect(useUIStore.getState().projectContextTab).toBe('plans');
    } finally {
      useUIStore.setState({ projectContextTab: previous });
      useProjectsStore.setState({ projects, activeProjectId });
    }
  });

  test('a detached panel waits for its catalog before delivering to the matching installation', async () => {
    const guest: InstalledGuest = {
      id: 'tasks', name: 'Tasks', icon: 'window', entry: 'panel.html', source: 'path',
      storageId: 'current-installation', capabilities: { requested: [], granted: [] },
    };
    const catalog = useGuestsStore.getState();
    useGuestsStore.setState({ status: 'loading', runtimeKey: getRuntimeKey(), guests: [] });
    const request = {
      kind: 'guest-open-surface', requestId: 'request', ownerId: 'window',
      directory: '/repo', runtimeKey: contextWindowRuntimeKey(), expiresAt: Date.now() + 1000,
      destination: {
        guestId: guest.id, installationKey: guestPanelInstallationKey(guest), item: { kind: 'link', identifier: 'DEMO-1' },
      },
    } as const;
    try {
      useContextWindowStore.setState({ followedDirectory: '/other' });
      expect(await openDetachedGuestSurface(request)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
      useContextWindowStore.setState({ followedDirectory: '/repo' });
      const oldInstallation = openDetachedGuestSurface({
        ...request, destination: { ...request.destination, installationKey: guestPanelInstallationKey({ ...guest, storageId: 'old-installation' }) },
      });
      const activeInstallation = openDetachedGuestSurface(request);
      expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
      useGuestsStore.getState().replaceCatalog([guest], getRuntimeKey());
      expect(await oldInstallation).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
      const pending = useGuestItemStore.getState().pendingItemByGuest[guest.id];
      expect(pending).toMatchObject({ item: { kind: 'link', identifier: 'DEMO-1' }, owner: guestPanelItemOwner(guest, '/repo') });
      pending.finish?.(true);
      expect(await activeInstallation).toEqual({ ok: true });
    } finally {
      useContextWindowStore.setState({ followedDirectory: null });
      useGuestsStore.setState(catalog);
      useGuestItemStore.setState({ pendingItemByGuest: {} });
    }
  });
});
