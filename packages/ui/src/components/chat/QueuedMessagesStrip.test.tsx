import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';
import { getMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { QueuedMessagesStrip } from './QueuedMessagesStrip';

const target: MessageQueueTarget = { runtimeKey: 'local', directory: '/repo', sessionId: 'ses_root' };

const queued = (id: string, content: string): QueuedMessage => ({ id, content, text: content, createdAt: 1 });

const theme = getDefaultTheme(false);
// Agent badges take their color from the theme.
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
  reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
  isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
  lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
};

const setQueue = (...messages: QueuedMessage[]) => act(async () => {
  useMessageQueueStore.setState({ queuedMessages: messages.length ? { [getMessageQueueKey(target)]: messages } : {} });
});

describe('QueuedMessagesStrip', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let sent: string[];

  const renderStrip = (composerAgentName: string) => act(async () => {
    root.render(
      <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
        <QueuedMessagesStrip target={target} composerAgentName={composerAgentName} onEditMessage={() => {}} onSendMessage={(id) => { sent.push(id); }} />
      </ThemeSystemContext.Provider></I18nProvider>,
    );
  });

  beforeEach(async () => {
    windowInstance = new Window({ url: 'http://localhost' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      // The UI store persists the expanded preference.
      localStorage: windowInstance.localStorage,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    sent = [];
    useMessageQueueStore.setState({ queuedMessages: {} });
    useUIStore.setState({ messageQueueExpanded: false });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await renderStrip('build');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
    useMessageQueueStore.setState({ queuedMessages: {} });
  });

  const buttons = () => [...host.querySelectorAll('button')];
  const button = (label: string) => buttons().find((item) => item.textContent === label || item.getAttribute('aria-label') === label);

  test('renders nothing while the queue is empty', () => {
    expect(host.innerHTML).toBe('');
  });

  test('one message is its own row with its actions and no header', async () => {
    await setQueue(queued('q1', 'Also pull main'));
    expect(host.textContent).toContain('Also pull main');
    expect(host.querySelector('[aria-expanded]')).toBeNull();
    expect(button('Drag to reorder')).toBeUndefined();
    await act(async () => button('send')?.click());
    expect(sent).toEqual(['q1']);
    expect(button('Remove from queue')).toBeDefined();
  });

  test('several messages collapse into a count that expands into a reorderable list', async () => {
    await setQueue(queued('q1', 'First'), queued('q2', 'Second'));
    expect(host.textContent).toContain('Queued messages 2');
    expect(host.textContent).not.toContain('First');

    const header = host.querySelector<HTMLButtonElement>('[aria-expanded]');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => header?.click());
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(useUIStore.getState().messageQueueExpanded).toBe(true);
    expect(host.textContent).toContain('First');
    expect(host.textContent).toContain('Second');
    expect(buttons().filter((item) => item.getAttribute('aria-label') === 'Drag to reorder')).toHaveLength(2);
  });

  test('a row names its captured agent only while the composer is on another one', async () => {
    const asAgent = (message: QueuedMessage, agent: string): QueuedMessage => ({ ...message, sendConfig: { providerID: 'p', modelID: 'm', agent } });
    await act(async () => useUIStore.setState({ messageQueueExpanded: true }));
    await setQueue(asAgent(queued('q1', 'First'), 'build'), asAgent(queued('q2', 'Second'), 'plan'), queued('q3', 'Third'));
    const rowText = (content: string) => [...host.querySelectorAll('.oc-composer-row')]
      .find((row) => row.textContent?.includes(content))?.textContent ?? '';

    expect(rowText('First')).not.toContain('Build');
    expect(rowText('Second')).toContain('Plan');
    expect(rowText('Third')).toBe('Thirdeditsend');

    await renderStrip('plan');
    expect(rowText('First')).toContain('Build');
    expect(rowText('Second')).not.toContain('Plan');
    expect(rowText('Third')).toBe('Thirdeditsend');
  });
});
