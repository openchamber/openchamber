import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from '@/stores/useUIStore';
import { toggleExpandedContextZone } from './toggleExpandedZone';

const panel = () => useUIStore.getState().contextPanelByDirectory['/repo'];

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextSurfaceZones: {},
    contextEditorVisible: true,
    contextEditorTreeVisible: true,
  });
});

describe('toggleExpandedContextZone', () => {
  test('expands the zone on screen, then collapses it', () => {
    useUIStore.getState().openContextSurface('/repo', 'git');
    toggleExpandedContextZone('/repo');
    expect(panel()?.expanded).toBe(true);
    toggleExpandedContextZone('/repo');
    expect(panel()?.expanded).toBe(false);
  });

  test('skips a zone showing only the file tree and expands another one', () => {
    const store = useUIStore.getState();
    store.moveContextSurfaceToZone('terminal', 'left');
    store.openContextSurface('/repo', 'file');
    store.toggleContextPanelExpanded('/repo', 'right');
    store.openContextSurface('/repo', 'terminal');

    toggleExpandedContextZone('/repo');

    expect(panel()?.zones.left.expanded).toBe(true);
  });

  test('with nothing open, opens Git where it is placed, expanded', () => {
    useUIStore.getState().moveContextSurfaceToZone('git', 'left');

    toggleExpandedContextZone('/repo');

    expect(panel()?.zones.left).toMatchObject({ isOpen: true, expanded: true });
  });
});
