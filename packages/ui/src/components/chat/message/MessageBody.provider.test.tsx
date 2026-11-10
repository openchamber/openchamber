import React, { act } from 'react';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SyncProvider } from '@/sync/sync-context';

plugin({
  name: 'message-provider-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const browser = new Window({ url: 'http://localhost/' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement, Event: browser.Event, MouseEvent: browser.MouseEvent,
  customElements: browser.customElements, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { default: MessageBody } = await import('./MessageBody');
const unavailable = (): never => { throw new Error('Message rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); }, get git() { return unavailable(); },
  get files() { return unavailable(); }, get settings() { return unavailable(); },
  get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => Response.json([]) });
const theme = getDefaultTheme(true);
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
  setTheme: unavailable, reloadCustomThemes: unavailable, importTheme: unavailable,
  deleteImportedTheme: unavailable, isSystemPreference: false, setSystemPreference: unavailable,
  themeMode: 'dark', setThemeMode: unavailable, lightThemeId: getDefaultTheme(false).metadata.id,
  darkThemeId: theme.metadata.id, setLightThemePreference: unavailable, setDarkThemePreference: unavailable,
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderMessage() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeAPIContext.Provider value={runtimeApis}>
        <ThemeSystemContext.Provider value={themeContext}>
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <MessageBody
              messageId="answer" parts={[]} isUser={false} isMessageCompleted messageFinish="stop"
              isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
              onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
              hasTextContent footerProviderID="sharellm" footerModelName="Test model" footerAgentName="build"
              turnGroupingContext={{ turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
                isLatestTurn: true, isWorking: false, hasTools: false, hasReasoning: false }}
            />
          </I18nProvider>
        </SyncProvider>
        </ThemeSystemContext.Provider>
      </RuntimeAPIContext.Provider>,
    );
  });
  const model = container.querySelector('[data-fact-model]');
  expect(model?.textContent).toBe('Test model');
  return model?.parentElement;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = undefined;
  useUIStore.setState({ customProviderIcons: {} });
});
afterAll(() => {
  browser.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('message footer provider mark', () => {
  test('shows the chosen provider icon beside the model', async () => {
    useUIStore.setState({ customProviderIcons: { sharellm: 'server' } });
    const footer = await renderMessage();
    expect(footer?.querySelector('use')?.getAttribute('href')).toBe('#oc-server');
    expect(footer?.querySelector('img')).toBeNull();
  });

  test('shows the agent icon when the provider logo fails', async () => {
    useUIStore.setState({ customProviderIcons: {} });
    const footer = await renderMessage();
    const image = footer?.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('');
    await act(async () => { image?.dispatchEvent(new Event('error')); });
    expect(footer?.querySelector('img')).toBeNull();
    expect(footer?.querySelector('use')?.getAttribute('href')).toBe('#oc-brain-ai-3');
  });
});
