import { afterEach, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();

afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

test('the initial sidebar width is independent of its resize minimum', () => {
  expect(useUIStore.getInitialState().sidebarWidth).toBe(280);
});

for (const width of [168, 280, 360]) {
  test(`reopening a persisted ${width}px sidebar preserves its width`, async () => {
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({ version: originalOptions.version, state: { sidebarWidth: width, isSidebarOpen: true } }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });
    useUIStore.setState(useUIStore.getInitialState(), true);
    await useUIStore.persist.rehydrate();

    const actions = useUIStore.getState();
    actions.toggleSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
    expect(useUIStore.getState().sidebarWidth).toBe(width);
    actions.toggleSidebar();
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    expect(useUIStore.getState().sidebarWidth).toBe(width);

    actions.setSidebarOpen(false);
    actions.setSidebarOpen(true);
    expect(useUIStore.getState().sidebarWidth).toBe(width);
    const openState = useUIStore.getState();
    actions.setSidebarOpen(true);
    expect(useUIStore.getState()).toBe(openState);
  });
}

test('a manual resize stays authoritative across repeated visibility changes', () => {
  useUIStore.setState(useUIStore.getInitialState(), true);
  const actions = useUIStore.getState();
  actions.setSidebarWidth(420);
  actions.setSidebarOpen(false);
  actions.setSidebarOpen(true);
  actions.toggleSidebar();
  actions.toggleSidebar();
  expect(useUIStore.getState().sidebarWidth).toBe(420);
});
