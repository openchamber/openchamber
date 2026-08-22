import { beforeEach, describe, expect, test } from 'bun:test';
import { useBtwStore } from './useBtwStore';

describe('useBtwStore', () => {
  beforeEach(() => {
    useBtwStore.setState({ byParent: {} });
  });

  test('starts empty', () => {
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('setPanelState merges patches per parent', () => {
    useBtwStore.getState().setPanelState('parent-1', { creating: true });
    useBtwStore.getState().setPanelState('parent-1', { collapsed: true });
    expect(useBtwStore.getState().byParent['parent-1']).toEqual({ creating: true, collapsed: true });
  });

  test('parents are independent', () => {
    useBtwStore.getState().setPanelState('parent-1', { collapsed: true });
    useBtwStore.getState().setPanelState('parent-2', { destroying: true });
    expect(useBtwStore.getState().byParent['parent-1']).toEqual({ collapsed: true });
    expect(useBtwStore.getState().byParent['parent-2']).toEqual({ destroying: true });
  });

  test('clearPanelState removes only its parent entry', () => {
    useBtwStore.getState().setPanelState('parent-1', { collapsed: true });
    useBtwStore.getState().setPanelState('parent-2', { collapsed: true });
    useBtwStore.getState().clearPanelState('parent-1');
    expect(useBtwStore.getState().byParent).toEqual({ 'parent-2': { collapsed: true } });
  });

  test('clearPanelState on an unknown parent is a no-op', () => {
    const before = useBtwStore.getState().byParent;
    useBtwStore.getState().clearPanelState('missing');
    expect(useBtwStore.getState().byParent).toBe(before);
  });
});
