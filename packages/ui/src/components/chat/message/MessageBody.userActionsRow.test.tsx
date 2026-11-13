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
import { compileAst } from 'tailwindcss';

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

const container = browser.document.createElement('div');
container.innerHTML = renderUserActionsRow();
const row = container.querySelector('[class~="group/user-actions"] > div');
if (!row) throw new Error('User actions row did not render');
const compiler = await compileAst([{ kind: 'at-rule', name: '@tailwind', params: 'utilities', nodes: [] }]);
const css = compiler.build(Array.from(row.classList));
type CssNode = (typeof css)[number];

// Evaluate the emitted selectors against the real row markup. Happy DOM has
// no input modality, so attributes stand in for browser-owned pseudo states.
const rowStyle = (hover: 'none' | 'hover', pointer: 'fine' | 'coarse', focus: 'none' | 'mouse' | 'keyboard', hovered = false) => {
  const fixture = container.cloneNode(true);
  const row = fixture.querySelector('[class~="group/user-actions"] > div');
  if (!row) throw new Error('User actions row did not render');
  const button = row.querySelector('button');
  if (!button) throw new Error('Copy button did not render');
  button.toggleAttribute('data-test-focused', focus !== 'none');
  button.toggleAttribute('data-test-focus-visible', focus === 'keyboard');
  fixture.firstElementChild?.toggleAttribute('data-test-hovered', hovered);
  const style: Record<string, string | undefined> = {};
  const visit = (nodes: CssNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'rule') {
        const simulatedSelector = node.selector.replaceAll('&', '')
          // Happy DOM cannot match the group combinator inside :is().
          .replaceAll(/:where\(([^)]+)\)/g, '$1')
          .replace(/^:is\((.*)\)$/, '$1')
          .replaceAll(/(?<!\\):focus-visible/g, '[data-test-focus-visible]')
          .replaceAll(/(?<!\\):focus-within/g, ':has([data-test-focused])')
          .replaceAll(/(?<!\\):hover/g, '[data-test-hovered]');
        if (row.matches(simulatedSelector)) visit(node.nodes);
      } else if (node.kind === 'at-rule' && node.name === '@media') {
        const query = node.params.replaceAll(' ', '');
        if (query === `(hover:${hover})` || query === `(pointer:${pointer})`) visit(node.nodes);
      } else if (node.kind === 'declaration' && (node.property === 'opacity' || node.property === 'pointer-events')) {
        style[node.property] = node.value;
      }
    }
  };
  visit(css);
  return style;
};

for (const pointer of ['fine', 'coarse'] as const) {
  test(`no-hover ${pointer} pointer exposes user actions without focus (#6043)`, () => {
    expect(rowStyle('none', pointer, 'none')).toEqual({ opacity: '100%', 'pointer-events': 'auto' });
  });

  test(`hover-capable ${pointer} pointer reveals actions on hover or keyboard focus only`, () => {
    const hidden = { opacity: '0%', 'pointer-events': 'none' };
    const visible = { opacity: '100%', 'pointer-events': 'auto' };
    expect(rowStyle('hover', pointer, 'none')).toEqual(hidden);
    expect(rowStyle('hover', pointer, 'mouse')).toEqual(hidden);
    expect(rowStyle('hover', pointer, 'keyboard')).toEqual(visible);
    expect(rowStyle('hover', pointer, 'none', true)).toEqual(visible);
    expect(rowStyle('hover', pointer, 'none')).toEqual(hidden);
  });
}
