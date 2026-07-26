import { beforeEach, describe, expect, test } from 'bun:test';
import { contextPanelForPersistence, useUIStore } from './useUIStore';

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

  test('preserves explicit disposable identity without affecting generic tabs', () => {
    const directory = '/repo';
    const disposableSideChat = {
      runtimeKey: 'runtime-a',
      directory,
      parentSessionId: 'parent-1',
      sideSessionId: 'side-1',
    };

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:side-1',
      disposableSideChat,
    });
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'file',
      targetPath: '/repo/file.ts',
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs.find((tab) => tab.mode === 'chat')?.disposableSideChat).toEqual(disposableSideChat);
    expect(tabs.find((tab) => tab.mode === 'file')?.disposableSideChat).toBeNull();
  });

  test('does not persist disposable tabs while retaining generic tabs', () => {
    const directory = '/repo';
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:side-1',
      disposableSideChat: {
        runtimeKey: 'runtime-a',
        directory,
        parentSessionId: 'parent-1',
        sideSessionId: 'side-1',
      },
    });
    useUIStore.getState().openContextPanelTab(directory, { mode: 'file', targetPath: '/repo/file.ts' });

    const persisted = contextPanelForPersistence(useUIStore.getState().contextPanelByDirectory);
    expect(persisted[directory]?.tabs.map((tab) => tab.mode)).toEqual(['file']);
    expect(persisted[directory]?.tabs[0]?.targetPath).toBe('/repo/file.ts');
  });

  test('reuses the persistence projection while panel state is unchanged', () => {
    const input = useUIStore.getState().contextPanelByDirectory;
    expect(contextPanelForPersistence(input)).toBe(contextPanelForPersistence(input));
  });

  test('does not evict disposable tabs when the tab cap is exceeded', () => {
    const directory = '/repo';
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat', dedupeKey: 'session:side-1',
      disposableSideChat: { runtimeKey: 'runtime-a', directory, parentSessionId: 'parent', sideSessionId: 'side-1' },
    });
    for (let index = 0; index < 20; index += 1) {
      useUIStore.getState().openContextPanelTab(directory, { mode: 'file', targetPath: `/repo/file-${index}.ts` });
    }

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.disposableSideChat)).toBe(true);
  });

  test('does not evict a directory root containing a disposable tab when the root cap is exceeded', () => {
    const protectedDirectory = '/repo/protected';
    useUIStore.getState().openContextPanelTab(protectedDirectory, {
      mode: 'chat', dedupeKey: 'session:side-1',
      disposableSideChat: {
        runtimeKey: 'runtime-a', directory: protectedDirectory, parentSessionId: 'parent', sideSessionId: 'side-1',
      },
    });
    for (let index = 0; index < 25; index += 1) {
      useUIStore.getState().openContextPanelTab(`/repo/${index}`, { mode: 'file', targetPath: `/repo/${index}/file.ts` });
    }

    expect(useUIStore.getState().contextPanelByDirectory[protectedDirectory]?.tabs[0]?.disposableSideChat?.sideSessionId).toBe('side-1');
  });
});
