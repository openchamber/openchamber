import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ diffLayoutPreference: 'inline', diffFileLayout: {} });
});

describe('useUIStore diff layout', () => {
  test('the layout for all files becomes the setting and drops per-file choices', () => {
    const store = useUIStore.getState();
    store.setDiffFileLayout('a.ts', 'inline');
    store.setDiffFileLayout('b.ts', 'side-by-side');

    store.setDiffLayoutForAllFiles('side-by-side');

    expect(useUIStore.getState().diffLayoutPreference).toBe('side-by-side');
    expect(useUIStore.getState().diffFileLayout).toEqual({});
  });

  test('choosing the layout already set still drops the per-file choices that differ', () => {
    useUIStore.setState({ diffLayoutPreference: 'side-by-side' });
    useUIStore.getState().setDiffFileLayout('a.ts', 'inline');

    useUIStore.getState().setDiffLayoutForAllFiles('side-by-side');

    expect(useUIStore.getState().diffFileLayout).toEqual({});
  });

  test('the setting alone keeps per-file choices', () => {
    useUIStore.getState().setDiffFileLayout('a.ts', 'inline');

    useUIStore.getState().setDiffLayoutPreference('side-by-side');

    expect(useUIStore.getState().diffFileLayout).toEqual({ 'a.ts': 'inline' });
  });
});
