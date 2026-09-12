import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { savedServerBrowserSelectionsSchema } from './contextPanelServerBrowser';
import { useUIStore } from './useUIStore';

type PanelState = ReturnType<typeof useUIStore.getState>['contextPanelByDirectory'][string];
type PanelTab = PanelState['tabs'][number];
const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
const directory = '/project';
const legacyTab = (fields: Partial<PanelTab> = {}): PanelTab => ({
  id: 'browser:remote-one', mode: 'browser', backend: 'server-chrome',
  targetPath: 'https://one.example', targetDirectory: null, projectPlanId: null, projectPlanRef: null,
  dedupeKey: 'remote-one', label: null, sessionTitleFallback: null, readOnly: false,
  stagedDiff: false, diffScope: 'working', touchedAt: 1,
  browserSessionId: 'session-one', serverTargetId: 'target-one', ...fields,
});
const localTab = (): PanelTab => legacyTab({
  id: 'browser:local', dedupeKey: 'local', backend: undefined,
  browserSessionId: undefined, serverTargetId: undefined, targetPath: 'https://local.example',
});
const panel = () => useUIStore.getState().contextPanelByDirectory[directory];
const serverTab = () => panel()?.tabs.find((tab) => tab.mode === 'server-browser');
const hydrate = async (tabs: PanelTab[], activeTabId: string, version = 20,
  widthByMode: PanelState['widthByMode'] = { browser: 620, 'server-browser': 720 }) => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state: {
      ...useUIStore.getInitialState(), serverBrowserEnabled: true,
      contextPanelByDirectory: { [directory]: {
        isOpen: true, expanded: true, activeTabId, tabs, touchedAt: 10,
        widthByMode,
      } },
    } }),
    setItem: () => undefined, removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
};

beforeEach(() => { useUIStore.setState({ contextPanelByDirectory: {}, serverBrowserEnabled: true }); });
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

describe('server browser surface persistence', () => {
  test('migrates every legacy selection into one surface and retains the active pair', async () => {
    const second = legacyTab({ id: 'browser:remote-two', dedupeKey: 'remote-two', touchedAt: 5,
      browserSessionId: 'session-two', serverTargetId: 'target-two', targetPath: 'https://two.example' });
    await hydrate([localTab(), legacyTab(), second], 'browser:remote-one');
    expect(panel()?.tabs.map((tab) => tab.mode)).toEqual(['browser', 'server-browser']);
    expect(panel()?.activeTabId).toBe('server-browser');
    expect(serverTab()?.browserSessionId).toBe('session-one');
    expect(serverTab()?.serverTargetId).toBe('target-one');
    expect(serverTab()?.savedSelections?.map((item) => [item.browserSessionId, item.serverTargetId])).toEqual([
      ['session-two', 'target-two'], ['session-one', 'target-one'],
    ]);
    expect(panel()?.isOpen).toBe(true);
    expect(panel()?.expanded).toBe(true);
    expect(panel()?.widthByMode).toEqual({ browser: 620, 'server-browser': 720 });
    expect(panel()?.tabs[0]?.targetPath).toBe('https://local.example');
    expect(useUIStore.persist.getOptions().version).toBe(21);
  });

  test('keeps a local active tab and aggregates legacy selections before tab limits', async () => {
    const remotes = Array.from({ length: 41 }, (_, index) => legacyTab({
      id: `browser:remote-${index}`, dedupeKey: `remote-${index}`, touchedAt: index + 1,
      browserSessionId: `session-${index}`, serverTargetId: `target-${index}`,
    }));
    const local = localTab();
    await hydrate([local, ...remotes], local.id);
    expect(panel()?.activeTabId).toBe(local.id);
    expect(panel()?.tabs[0]?.id).toBe(local.id);
    expect(serverTab()?.browserSessionId).toBe('session-40');
    expect(serverTab()?.savedSelections).toHaveLength(41);
  });

  test('carries the previous shared browser width into the server surface without changing the local width', async () => {
    await hydrate([localTab(), legacyTab()], 'browser:remote-one', 20, { browser: 660 });
    expect(panel()?.widthByMode).toEqual({ browser: 660, 'server-browser': 660 });
  });

  test('retains session-only and target-only hints and deduplicates exact pairs only', async () => {
    const sessionOnly = legacyTab({ id: 'browser:session', dedupeKey: 'session', serverTargetId: undefined });
    const targetOnly = legacyTab({ id: 'browser:target', dedupeKey: 'target', browserSessionId: undefined });
    const duplicate = legacyTab({ id: 'browser:duplicate', dedupeKey: 'duplicate', touchedAt: 9, targetPath: 'https://new.example' });
    await hydrate([legacyTab(), sessionOnly, targetOnly, duplicate], 'browser:remote-one');
    expect(serverTab()?.savedSelections).toHaveLength(3);
    expect(serverTab()?.savedSelections?.[0]?.targetPath).toBe('https://new.example');
    expect(serverTab()?.savedSelections?.some((item) => item.browserSessionId === 'session-one' && !item.serverTargetId)).toBe(true);
    expect(serverTab()?.savedSelections?.some((item) => !item.browserSessionId && item.serverTargetId === 'target-one')).toBe(true);
  });

  test('round-trips the aggregate through version 21 without changing its selection', async () => {
    await hydrate([legacyTab(), legacyTab({ id: 'browser:second', dedupeKey: 'second', browserSessionId: 'session-two' })], 'browser:remote-one');
    const saved = panel()?.tabs ?? [];
    const previous = serverTab();
    await hydrate(saved, 'server-browser', 21);
    expect(serverTab()).toEqual(previous);
    expect(panel()?.tabs).toHaveLength(1);
  });

  test('sanitizes each saved entry independently instead of erasing valid siblings', () => {
    const saved = savedServerBrowserSelectionsSchema.parse([
      { browserSessionId: ' session ', serverTargetId: ' target ', targetPath: 'https://example.com', touchedAt: 1 },
      null, { browserSessionId: 42 },
      { browserSessionId: 'another', serverTargetId: 42, touchedAt: 2 },
    ]);
    expect(saved).toEqual([
      { browserSessionId: 'another', serverTargetId: undefined, targetPath: null, touchedAt: 2 },
      { browserSessionId: 'session', serverTargetId: 'target', targetPath: 'https://example.com', touchedAt: 1 },
    ]);
  });
});

describe('server browser surface actions', () => {
  test('opens one server surface while ordinary browser tabs stay independent', () => {
    const state = useUIStore.getState();
    state.openNewContextServerBrowserTab(directory);
    state.openNewContextServerBrowserTab(directory);
    state.openNewContextBrowserTab(directory);
    state.openNewContextBrowserTab(directory);
    expect(panel()?.tabs.filter((tab) => tab.mode === 'server-browser')).toHaveLength(1);
    expect(panel()?.tabs.filter((tab) => tab.mode === 'browser')).toHaveLength(2);
    state.openContextSurface(directory, 'server-browser');
    expect(panel()?.activeTabId).toBe('server-browser');
    state.openContextSurface(directory, 'server-browser');
    expect(panel()?.isOpen).toBe(false);
    expect(serverTab()?.id).toBe('server-browser');
  });

  test('normalizes legacy open descriptors to the dedicated singleton', () => {
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'browser', backend: 'server-chrome', dedupeKey: 'old-remote',
      browserSessionId: 'session', serverTargetId: 'target',
    });
    expect(serverTab()?.id).toBe('server-browser');
    expect(serverTab()?.browserSessionId).toBe('session');
    expect(serverTab()?.savedSelections).toHaveLength(1);
  });

  test('upserts confirmed IDs and URL without deleting siblings and retains history after end', async () => {
    await hydrate([legacyTab()], 'browser:remote-one');
    const state = useUIStore.getState();
    state.setContextPanelTabServerBrowser(directory, 'server-browser', {
      browserSessionId: 'session-two', serverTargetId: 'target-two', targetPath: 'https://two.example',
    });
    state.setContextPanelTabTargetPath(directory, 'server-browser', 'https://navigated.example');
    expect(serverTab()?.savedSelections).toHaveLength(2);
    expect(serverTab()?.savedSelections?.find((item) => item.browserSessionId === 'session-two')?.targetPath).toBe('https://navigated.example');
    state.setContextPanelTabServerBrowser(directory, 'server-browser', { browserSessionId: null, serverTargetId: null });
    expect(serverTab()?.browserSessionId).toBe(undefined);
    expect(serverTab()?.serverTargetId).toBe(undefined);
    expect(serverTab()?.savedSelections).toHaveLength(2);
    state.openNewContextServerBrowserTab(directory);
    expect(serverTab()?.browserSessionId).toBe(undefined);
    expect(serverTab()?.savedSelections).toHaveLength(2);
  });

  test('rejects server opens when disabled and continues to allow local browser opens', () => {
    useUIStore.setState({ serverBrowserEnabled: false });
    const state = useUIStore.getState();
    state.openContextSurface(directory, 'server-browser');
    state.openNewContextServerBrowserTab(directory);
    state.openContextPanelTab(directory, { mode: 'browser', backend: 'server-chrome' });
    expect(panel()).toBe(undefined);
    state.openNewContextBrowserTab(directory);
    expect(panel()?.tabs.map((tab) => tab.mode)).toEqual(['browser']);
  });
});
