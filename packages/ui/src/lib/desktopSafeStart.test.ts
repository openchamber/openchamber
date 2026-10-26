import { beforeEach, describe, expect, test } from 'bun:test';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { forgetLayoutForSafeStart } from './desktopSafeStart';

const flushDeferredWrites = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {} });
  useFilesViewTabsStore.setState({ byRoot: {}, activeRuntimeKey: 'runtime-a', runtimeSnapshots: {} });
});

describe('forgetLayoutForSafeStart', () => {
  test('collapses every folder and closes open files in every project', () => {
    const files = useFilesViewTabsStore.getState();
    files.expandPath('/repo', '/repo/huge');
    files.addOpenPath('/repo', '/repo/huge/a.json');
    files.expandPath('/other', '/other/src');
    useFilesViewTabsStore.setState({
      runtimeSnapshots: { 'runtime-b': { byRoot: { '/remote': { openPaths: [], selectedPath: null, expandedPaths: ['/remote/x'], touchedAt: 1 } }, updatedAt: 1 } },
    });

    forgetLayoutForSafeStart();

    expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
    expect(useFilesViewTabsStore.getState().runtimeSnapshots).toEqual({});
  });

  test('closes the panels of every project and keeps their tabs for reopening', () => {
    const ui = useUIStore.getState();
    ui.openContextFile('/repo', '/repo/a.ts');
    ui.openContextSurface('/other', 'terminal');
    const tabsBefore = useUIStore.getState().contextPanelByDirectory['/repo'].tabs.map((tab) => tab.id);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(true);

    forgetLayoutForSafeStart();

    const panels = useUIStore.getState().contextPanelByDirectory;
    for (const panel of Object.values(panels)) {
      expect(panel.isOpen).toBe(false);
      expect(panel.zones.left.isOpen).toBe(false);
      expect(panel.zones.bottom.isOpen).toBe(false);
    }
    expect(panels['/repo'].tabs.map((tab) => tab.id)).toEqual(tabsBefore);
  });

  test('keeps settings that are not layout', () => {
    useUIStore.setState({ fontSize: 117 });
    useUIStore.getState().openContextFile('/repo', '/repo/a.ts');

    forgetLayoutForSafeStart();

    expect(useUIStore.getState().fontSize).toBe(117);
  });

  test('saves the forgotten layout, so the next launch starts without it too', async () => {
    useFilesViewTabsStore.getState().expandPath('/repo', '/repo/huge');
    useUIStore.getState().openContextFile('/repo', '/repo/a.ts');
    await flushDeferredWrites();
    expect(getSafeStorage().getItem('files-view-tabs-store')).toContain('/repo/huge');

    forgetLayoutForSafeStart();
    await flushDeferredWrites();

    expect(getSafeStorage().getItem('files-view-tabs-store')).not.toContain('/repo/huge');
    const savedUi = JSON.parse(getSafeStorage().getItem('ui-store') ?? '{}');
    expect(savedUi.state.contextPanelByDirectory['/repo'].isOpen).toBe(false);
  });
});
