import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import { openGuestSurfaceInContextWindow, startContextWindowOwner } from './owner';
import { startContextWindowPanel } from './panel';
import * as role from './role';
import { useContextWindowStore } from './store';

test('the owner receives a failure reply when the detached tab cannot open', async () => {
  const dom = new Window({ url: 'http://context.test/' });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
  const storage = getSafeSessionStorage();
  const ownerId = 'test-owner';
  storage.setItem('openchamber.window-id', ownerId);
  storage.setItem('openchamber.context-window.detached', '1');
  const context = useContextWindowStore.getState();
  const projects = useProjectsStore.getState();
  const ui = useUIStore.getState();
  useContextWindowStore.setState({ followedDirectory: '/repo' });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo' }], activeProjectId: 'project' });
  ui.openContextSurface('/repo', 'notes');
  useUIStore.setState({ setProjectContextTab: () => { throw new Error('Could not set the tab'); } });
  const stopOwner = startContextWindowOwner();
  // The two actual channel listeners share a test process, but the panel has its own URL.
  const panelRole = spyOn(role, 'contextWindowOwnerId');
  panelRole.mockReturnValue(ownerId);
  const stopPanel = startContextWindowPanel();
  try {
    expect(await openGuestSurfaceInContextWindow('/repo', { tab: 'todos' })).toMatchObject({
      ok: false,
      code: 'HOST_UNAVAILABLE',
      message: 'The detached context panel could not open the surface.',
    });
  } finally {
    stopPanel();
    panelRole.mockRestore();
    stopOwner();
    useContextWindowStore.setState(context);
    useProjectsStore.setState(projects);
    useUIStore.setState(ui);
    storage.removeItem('openchamber.window-id');
    storage.removeItem('openchamber.context-window.detached');
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
    await dom.happyDOM.close();
  }
}, 2000);
