import { beforeEach, describe, expect, test } from 'bun:test';
import { useBtwStore } from './useBtwStore';

describe('useBtwStore', () => {
  beforeEach(() => {
    useBtwStore.getState().closeBtw();
  });

  test('starts closed', () => {
    expect(useBtwStore.getState().panel).toEqual({
      sessionId: null,
      directory: null,
      title: null,
      forkedAtMs: null,
    });
  });

  test('openBtw records the fork identity', () => {
    useBtwStore.getState().openBtw('fork-1', '/project', 'btw: wtf is kafka', 1234);
    expect(useBtwStore.getState().panel).toEqual({
      sessionId: 'fork-1',
      directory: '/project',
      title: 'btw: wtf is kafka',
      forkedAtMs: 1234,
    });
  });

  test('openBtw replaces an existing panel', () => {
    useBtwStore.getState().openBtw('fork-1', '/project', 'btw: first', 1);
    useBtwStore.getState().openBtw('fork-2', '/project', 'btw: second', 2);
    expect(useBtwStore.getState().panel.sessionId).toBe('fork-2');
  });

  test('closeBtw clears the panel identity', () => {
    useBtwStore.getState().openBtw('fork-1', '/project', 'btw: wtf is kafka', 1234);
    useBtwStore.getState().closeBtw();
    expect(useBtwStore.getState().panel.sessionId).toBeNull();
    expect(useBtwStore.getState().panel.forkedAtMs).toBeNull();
  });

  test('closeBtw on an already-closed panel is a no-op', () => {
    useBtwStore.getState().closeBtw();
    expect(useBtwStore.getState().panel.sessionId).toBeNull();
  });
});
