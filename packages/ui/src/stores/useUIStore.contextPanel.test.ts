import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {} });
});

describe('useUIStore context panel tabs', () => {
  test('updates readOnly when an existing chat tab is reopened', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: true,
    });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: false,
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.readOnly).toBe(false);
  });

  test('persists branch as the selected diff scope', () => {
    const directory = '/repo';

    useUIStore.getState().openContextDiff(directory, 'src/file.ts', false, 'branch');
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'file',
      targetPath: 'src/other.ts',
    });

    const diffTab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs
      .find((tab) => tab.mode === 'diff');
    expect(diffTab?.diffScope).toBe('branch');
    expect(diffTab?.stagedDiff).toBe(false);
  });
});
