import React from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenCode } from '@opencode/client';
import type { Part } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { Window } from 'happy-dom';

// The user body reads window-scoped device state while rendering; a bare
// happy-dom window covers that without mounting.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  customElements: browser.customElements,
  Event: browser.Event, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

// Bun needs the asset URL that Vite normally supplies to the real renderer.
plugin({
  name: 'message-user-actions-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: MessageBody } = await import('./MessageBody');

const unavailable = (): never => { throw new Error('Message rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => Response.json([]) });
const userText: Part = { id: 'text', sessionID: 'session', messageID: 'user', type: 'text', text: 'Hello there.', time: { start: 1, end: 2 } };

const renderUserActionsRow = () => renderToStaticMarkup(
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <SyncProvider sdk={sdk} directory="">
      <I18nProvider>
        <MessageBody
          messageId="user"
          parts={[userText]}
          isUser
          isMessageCompleted
          messageFinish="stop"
          isMobile={false}
          copiedCode={null}
          onCopyCode={() => {}}
          expandedTools={new Set()}
          onToggleTool={() => {}}
          onShowPopup={() => {}}
          streamPhase="completed"
          allowAnimation={false}
          hasTextContent
          onCopyMessage={() => {}}
          userMessagePart="actions"
        />
      </I18nProvider>
    </SyncProvider>
  </RuntimeAPIContext.Provider>,
);

test('the user actions row stays reachable where hover never lands (#6043)', () => {
  const markup = renderUserActionsRow();
  // The row renders in its hover-reveal form on a non-mobile surface; a
  // window whose pointer never hovers must still be able to raise it.
  expect(markup).toContain('group/user-actions');
  expect(markup).toContain('pointer-coarse:opacity-100');
  expect(markup).toContain('pointer-coarse:pointer-events-auto');
  expect(markup).toContain('focus-within:opacity-100');
});
