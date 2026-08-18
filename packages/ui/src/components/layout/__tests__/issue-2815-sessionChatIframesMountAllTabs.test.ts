/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/2815
 *
 * A full ContextPanel mount is not available in bun test because its import
 * graph includes a Vite worker URL. This test follows the source-level guard
 * pattern in contextPanelEscapeClosesTerminal.test.ts and uses the real store.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultTheme } from '@/lib/theme/themes';
import { useUIStore } from '@/stores/useUIStore';
import {
  buildEmbeddedSessionChatURL,
  getActiveEmbeddedSessionChatTab,
  resetEmbeddedSessionChatCache,
} from '../contextPanelEmbeddedChat';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf-8');
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');

type FixtureTab = {
  id: string;
  mode: 'chat' | 'git' | 'diff' | 'plan';
  targetPath: string | null;
  dedupeKey: string;
  label: string | null;
  sessionTitleFallback: string | null;
  readOnly: boolean;
  stagedDiff: boolean;
  diffScope: 'working';
  touchedAt: number;
};

const DIRECTORY = '/path/to/repository';
const originalWindow = globalThis.window;

const installWindowLocation = () => {
  const url = new URL('http://127.0.0.1:3000/');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
      },
    },
  });
};

const buildTab = (mode: FixtureTab['mode'], id: string): FixtureTab => ({
  id: mode === 'chat' ? `chat:session:${id}` : id,
  mode,
  targetPath: null,
  dedupeKey: mode === 'chat' ? `session:${id}` : id,
  label: mode === 'chat' ? `Session ${id}` : null,
  sessionTitleFallback: null,
  readOnly: mode === 'chat',
  stagedDiff: false,
  diffScope: 'working',
  touchedAt: Date.now(),
});

const sessionChatTabs = Array.from({ length: 8 }, (_, index) => buildTab('chat', `ses_${index + 1}`));
const issueScenarioTabs = [
  ...sessionChatTabs,
  buildTab('git', 'git'),
  buildTab('diff', 'diff'),
  buildTab('plan', 'plan'),
];

const installIssueScenario = () => {
  useUIStore.setState({
    contextPanelByDirectory: {
      [DIRECTORY]: {
        isOpen: true,
        expanded: false,
        tabs: issueScenarioTabs,
        activeTabId: sessionChatTabs[0].id,
        widthByMode: {},
        touchedAt: Date.now(),
      },
    } as never,
  });
};

beforeEach(() => {
  installWindowLocation();
  resetEmbeddedSessionChatCache();
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
  installIssueScenario();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('issue #2815 active-only chat iframe source guard', () => {
  test('does not map persisted chat tabs to iframe elements', () => {
    expect(contextPanelSource).not.toContain('{chatTabs.map((tab) => {');
  });

  test('renders the iframe only when an active chat has a session and URL', () => {
    const start = contextPanelSource.indexOf('{activeChatTab && activeChatSessionID && activeChatSrc ? (');
    expect(start).toBeGreaterThan(-1);
    const end = contextPanelSource.indexOf(') : null}', start);
    expect(end).toBeGreaterThan(start);
    const block = contextPanelSource.slice(start, end);

    expect(block).toContain('<iframe');
    expect(block).toContain('key={activeChatTab.id}');
    expect(block).toContain('src={activeChatSrc}');
    expect(block).toContain('postEmbeddedVisibilityToChats();');
    expect(block).not.toContain("'block' : 'hidden'");
  });

  test('does not select a chat iframe when the context panel is closed', () => {
    expect(contextPanelSource).toContain(
      "const activeChatTabID = isOpen && activeTab?.mode === 'chat' ? activeTab.id : null;",
    );
    expect(contextPanelSource).toContain(
      "const activeChatSessionID = isOpen && activeTab?.mode === 'chat'",
    );
  });

  test('answers the mounted iframe visibility handshake from the active tab', () => {
    expect(contextPanelSource).toContain('data?.type === EMBEDDED_VISIBILITY_REQUEST');
    expect(contextPanelSource).toContain('frame.contentWindow === event.source');
    expect(contextPanelSource).toContain('payload: { visible: activeChatTabID === tabID }');
  });

  test('requests authoritative visibility after installing the iframe listener', () => {
    const effectStart = appSource.indexOf('const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {');
    const listenerIndex = appSource.indexOf("window.addEventListener('message', handleMessage);", effectStart);
    const requestIndex = appSource.indexOf('requestEmbeddedSessionVisibility();', effectStart);

    expect(effectStart).toBeGreaterThan(-1);
    expect(listenerIndex).toBeGreaterThan(effectStart);
    expect(requestIndex).toBeGreaterThan(listenerIndex);
  });

  test('gates embedded chat background work on visibility but keeps message history enabled', () => {
    expect(appSource).toContain(
      'const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;',
    );
    expect(appSource).toContain('active={embeddedBackgroundWorkEnabled}');
    expect(appSource).toContain('messagesEnabled={true}');
    expect(appSource).toContain(
      'useWebNotificationStream({ enabled: embeddedBackgroundWorkEnabled });',
    );
  });
});

describe('issue #2815 persisted scenario', () => {
  test('keeps all tab records but selects one chat for mounting', () => {
    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    const chatTabs = panel.tabs.filter((tab) => tab.mode === 'chat');
    const activeTab = getActiveEmbeddedSessionChatTab(chatTabs, panel.activeTabId);

    expect(panel.tabs).toHaveLength(11);
    expect(chatTabs).toHaveLength(8);
    expect(activeTab?.id).toBe(sessionChatTabs[0].id);
  });

  test('produces one live embedded URL for eight persisted chats', () => {
    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    const chatTabs = panel.tabs.filter((tab) => tab.mode === 'chat');
    const activeTab = getActiveEmbeddedSessionChatTab(chatTabs, panel.activeTabId);
    const frames = activeTab ? [buildEmbeddedSessionChatURL('ses_1', DIRECTORY, activeTab.readOnly, {
      mode: 'system',
      lightThemeId: 'light',
      darkThemeId: 'dark',
      currentTheme: getDefaultTheme(true),
    })] : [];

    expect(frames).toHaveLength(1);
    const url = new URL(frames[0]);
    expect(url.searchParams.get('ocPanel')).toBe('session-chat');
    expect(url.searchParams.get('sessionId')).toBe('ses_1');
    expect(url.searchParams.get('readOnly')).toBe('1');
  });

  test('selects another single chat after a tab switch', () => {
    useUIStore.getState().setActiveContextPanelTab(DIRECTORY, sessionChatTabs[6].id);

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    const chatTabs = panel.tabs.filter((tab) => tab.mode === 'chat');
    const activeTab = getActiveEmbeddedSessionChatTab(chatTabs, panel.activeTabId);

    expect(activeTab?.id).toBe(sessionChatTabs[6].id);
    expect(chatTabs.filter((tab) => tab.id === activeTab?.id)).toHaveLength(1);
  });

  test('selects no chat after the panel closes', () => {
    useUIStore.getState().closeContextPanel(DIRECTORY);

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    const chatTabs = panel.tabs.filter((tab) => tab.mode === 'chat');
    const activeTabID = panel.isOpen ? panel.activeTabId : null;

    expect(panel.isOpen).toBe(false);
    expect(getActiveEmbeddedSessionChatTab(chatTabs, activeTabID)).toBeNull();
  });
});
