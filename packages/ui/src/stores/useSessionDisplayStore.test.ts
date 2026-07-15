import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionDisplayStore } from './useSessionDisplayStore';

describe('useSessionDisplayStore project preferences', () => {
  beforeEach(() => {
    useSessionDisplayStore.setState({
      preserveProjectNameCasing: false,
      autoCloseEmptyProjects: false,
    });
  });

  test('keeps project preferences disabled by default', () => {
    const state = useSessionDisplayStore.getState();
    expect(state.preserveProjectNameCasing).toBe(false);
    expect(state.autoCloseEmptyProjects).toBe(false);
  });

  test('toggles project preferences independently', () => {
    useSessionDisplayStore.getState().togglePreserveProjectNameCasing();
    expect(useSessionDisplayStore.getState().preserveProjectNameCasing).toBe(true);
    expect(useSessionDisplayStore.getState().autoCloseEmptyProjects).toBe(false);

    useSessionDisplayStore.getState().toggleAutoCloseEmptyProjects();
    expect(useSessionDisplayStore.getState().autoCloseEmptyProjects).toBe(true);
  });
});
