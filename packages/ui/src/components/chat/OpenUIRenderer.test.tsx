import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { OpenUISubmission } from './openui/openuiHost';
import React, { act } from 'react';
import { plugin } from 'bun';

plugin({
  name: 'openui-preview-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({
      contents: 'export default "http://localhost/worker.js";',
      loader: 'js',
    }));
  },
});

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement,
  HTMLImageElement: browser.HTMLImageElement,
  customElements: browser.customElements,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element,
  Event: browser.Event,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const realFetch = globalThis.fetch;
const requests: string[] = [];
const { createRoot } = await import('react-dom/client');
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  if (url.includes('/api/location')) return Response.json({ directory: '/repo', project: { directory: '/repo' } });
  if (url.includes('/api/session')) return Response.json({ data: [], cursor: {} });
  if (url.includes('/openui')) throw new Error('OpenUI submissions must not require a capability request');
  return Response.json({});
};
const { OpenUIProgram } = await import('./OpenUIRenderer');
const { MarkdownContent } = await import('./MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { configureRuntimeUrlResolver } = await import('@/lib/runtime-url');
const { setSyncRefs } = await import('@/sync/sync-refs');
const { ChildStoreManager } = await import('@/sync/child-store');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useInputStore } = await import('@/sync/input-store');
const { setActionRefs, setOptimisticRefs } = await import('@/sync/session-actions');
const stores = new ChildStoreManager();
setSyncRefs(opencodeClient.getSdkClient(), stores, '/repo');
configureRuntimeUrlResolver({ apiBaseUrl: 'http://localhost' });
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => {
  await act(async () => root.unmount());
  await new Promise((resolve) => setTimeout(resolve, 450));
  globalThis.fetch = realFetch;
  browser.happyDOM.abort();
});

test('a duplicate pending action is delivered once and keeps the same renderer', async () => {
  let resolveAnswer: (() => void) | undefined;
  let calls = 0;
  const pending = new Promise<void>((resolve) => { resolveAnswer = resolve; });
  const owner = { runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'second' };
  const source = 'root = Stack([Buttons([Button("Send", @ToAssistant("Choose A"))])])';
  await act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="pending" source={source} owner={owner} renderKey="pending"
        canInteract={() => true} repeatable={false} submit={async () => { calls++; await pending; }} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  const button = host.querySelector('button');
  if (!button) throw new Error('Missing generated button');
  await act(async () => {
    button.click();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).toBe(1);
  expect(button.disabled).toBe(true);
  expect(requests.filter((url) => url.includes('/openui'))).toEqual([]);
  expect(host.querySelector('button')).toBe(button);
  await act(async () => { resolveAnswer?.(); });
  expect(host.textContent).toContain('Answer sent');
  expect(button.disabled).toBe(true);
});

test('native gallery inspects twelve sources, keeps successful images after a failure and reconnects after Activity', async () => {
  const fetchBefore = globalThis.fetch;
  const Observer = browser.IntersectionObserver;
  const inspected: string[] = [];
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('url-token')) {
      return Response.json({ token: 'test-token', expiresAt: Date.now() + 60_000 });
    }
    if (url.includes('/api/fs/stat')) {
      const path = new URL(url).searchParams.get('path') ?? '';
      inspected.push(path);
      return Response.json(path.endsWith('/gallery-1.png') ? { exists: false } : { isFile: true, path, size: 12 });
    }
    return fetchBefore(input, init);
  };
  const images = Array.from({ length: 13 }, (_, index) => ({ src: `gallery-${index}.png`, alt: `Picture ${index}` }));
  const source = `root = Stack([ImageGallery(${JSON.stringify(images)})])`;
  const program = (
    <OpenUIProgram source={source}
      owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 'gallery', messageId: 'gallery', partId: 'gallery' }}
      renderKey="gallery" canInteract={() => true} repeatable submit={async () => {}} />
  );
  const draw = (mode: 'visible' | 'hidden') => act(async () => root.render(
    <I18nProvider><ThemeSystemProvider><React.Activity mode={mode}>{program}</React.Activity></ThemeSystemProvider></I18nProvider>,
  ));
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  try {
    await draw('visible');
    await flush();
    expect(inspected).toEqual(images.slice(0, 12).map((image) => `/repo/${image.src}`));
    expect(host.querySelectorAll('img')).toHaveLength(11);
    expect(host.querySelector('img[alt="Picture 1"]')).toBeNull();
    expect(host.querySelector('img[alt="Picture 12"]')).toBeNull();
    expect(host.textContent).toContain('gallery-1.png');
    const image = host.querySelector('img');
    if (!image) throw new Error('Missing resolved gallery image');
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
    await act(async () => image.dispatchEvent(new Event('load')));
    expect(image.style.objectFit).toBe('cover');
    await draw('hidden');
    await draw('visible');
    await flush();
    expect(host.querySelector('img')).toBe(image);
    expect(host.querySelector('pre')).toBeNull();
    await act(async () => image.closest('button')?.click());
    const preview = () => document.querySelector('[aria-label="Close image preview"]');
    for (let attempt = 0; attempt < 30 && !preview(); attempt++) await flush();
    expect(useUIStore.getState().isImagePreviewOpen).toBe(true);
    expect(preview()).not.toBeNull();
    await draw('hidden');
    expect(useUIStore.getState().isImagePreviewOpen).toBe(false);
    await draw('visible');
    expect(useUIStore.getState().isImagePreviewOpen).toBe(false);
    expect(preview()).toBeNull();
  } finally {
    await act(async () => root.render(null));
    globalThis.fetch = fetchBefore;
    Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: Observer });
  }
});

test('a settled tool keeps its read-only UI without submitting', async () => {
  const source = 'root = Stack([Buttons([Button("Send", @ToAssistant("Choose A"))])])';
  let calls = 0;
  await act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="settled" source={source}
        owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'old' }}
        renderKey="settled" canInteract={() => false} terminal repeatable={false}
        submit={async () => { calls++; }} answer={{ selected: 'a' }} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  const button = host.querySelector('button');
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(true);
  await act(async () => { button?.click(); });
  expect(calls).toBe(0);
});

test('Markdown media loads only reachable OpenUI nodes after authored closure', async () => {
  const fetchBefore = globalThis.fetch;
  const Observer = browser.IntersectionObserver;
  const inspected: string[] = [];
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/fs/stat')) {
      const path = new URL(String(input)).searchParams.get('path') ?? '';
      inspected.push(path);
      return Response.json({ isFile: true, path, size: 12 });
    }
    if (String(input).includes('url-token')) return Response.json({ token: 'test-token', expiresAt: Date.now() + 60_000 });
    return fetchBefore(input, init);
  };
  const source = `root = Stack([Card([Card([Image("Nested", $path)])]), Grid([GridItem([ImageGallery([{src: "reachable-gallery.png", details: "metadata.png"}])])]), each, TextContent("Image(\\"Example\\", \\"quoted.png\\")")])
$path = "reachable-bound.png"
each = Stack(@Each(items, "item", Image(item.alt, item.src)))
items = [{alt: "Each", src: "reachable-each.png"}]
unused = Image("Unused", "unused.png")
records = [{src: "data-only.png"}]`;
  const draw = async (content: string, isStreaming = false) => {
    stores.ensureChild('/repo').setState({ part: {
      'media-source': [{ type: 'text', id: 'media-source', sessionID: 's', messageID: 'media-source', text: content }],
    } });
    await act(async () => root.render(
      <I18nProvider><ThemeSystemProvider>
        <MarkdownContent key="media-source" content={content} mode="streaming" isStreaming={isStreaming}
          directory="/repo" enableFileReferences={false}
          openuiOwner={{ sessionId: 's', messageId: 'media-source', partId: 'media-source' }} />
      </ThemeSystemProvider></I18nProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  };
  try {
    await draw(`\`\`\`openui-lang literal\n${source}\n\`\`\``);
    expect(host.querySelector('img')).toBeNull();
    await draw(`\`\`\`openui-lang\n${source}`, true);
    expect(host.querySelector('img')).toBeNull();
    await draw(`\`\`\`openui-lang\n${source}`);
    expect(inspected).toEqual([]);
    await draw(`\`\`\`openui-lang\n${source}\n\`\`\`\n`);
    expect([...inspected].sort()).toEqual(['/repo/reachable-bound.png', '/repo/reachable-each.png', '/repo/reachable-gallery.png']);
    expect(host.querySelectorAll('img')).toHaveLength(3);
    expect(host.querySelector('pre')).toBeNull();
  } finally {
    await act(async () => root.render(null));
    globalThis.fetch = fetchBefore;
    Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: Observer });
  }
});

test('a successful reply after the wait settles preserves its receipt and stays read-only', async () => {
  let resolveAnswer: (() => void) | undefined;
  let calls = 0;
  const pending = new Promise<void>((resolve) => { resolveAnswer = resolve; });
  const draw = (terminal: boolean) => act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="settling-receipt" source={'root = Stack([Button("Confirm", @ToAssistant("Confirm choice"))])'}
        owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'receipt' }}
        renderKey="receipt" canInteract={() => !terminal} terminal={terminal} repeatable={false}
        submit={async () => { calls++; await pending; }} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  await draw(false);
  const button = host.querySelector('button');
  if (!button) throw new Error('Missing confirmation');
  await act(async () => { button.click(); });
  await draw(true);
  expect(host.querySelector('button')).toBe(button);
  expect(button.disabled).toBe(true);
  await act(async () => { resolveAnswer?.(); });
  expect(host.textContent).toContain('Answer sent');
  await act(async () => { button.click(); });
  expect(calls).toBe(1);
});

test('a submission completed while Activity is hidden reconnects without reopening the prompt', async () => {
  let resolveAnswer: (() => void) | undefined;
  let calls = 0;
  const pending = new Promise<void>((resolve) => { resolveAnswer = resolve; });
  const program = <OpenUIProgram source={'root = Stack([Button("Confirm hidden", @ToAssistant("Confirm hidden choice"))])'}
    owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'hidden-receipt' }}
    renderKey="hidden-receipt" canInteract={() => true} repeatable={false}
    submit={async () => { calls++; await pending; }} />;
  const draw = (mode: 'visible' | 'hidden') => act(async () => root.render(
    <I18nProvider><ThemeSystemProvider><React.Activity mode={mode}>{program}</React.Activity></ThemeSystemProvider></I18nProvider>,
  ));
  await draw('visible');
  await act(async () => { host.querySelector('button')?.click(); });
  await draw('hidden');
  await act(async () => { resolveAnswer?.(); });
  await draw('visible');
  expect(host.querySelector('button')?.disabled).toBe(true);
  await act(async () => { host.querySelector('button')?.click(); });
  expect(calls).toBe(1);
});

test('Markdown actions send repeatable user turns without a managed capability or composer changes', async () => {
  setActionRefs(stores, () => '/repo');
  setOptimisticRefs(() => {}, () => {});
  useConfigStore.setState({ currentProviderId: 'provider', isConnected: true, hasEverConnected: true });
  useInputStore.getState().setPendingInputText('Keep the composer');
  const send = spyOn(opencodeClient, 'sendMessage').mockResolvedValue('message');
  const source = 'root = Stack([Button("Continue", @ToAssistant("Use choice"))])';
  const content = `\`\`\`openui-lang\n${source}\n\`\`\``;
  stores.ensureChild('/repo').setState({ part: {
    m: [{ type: 'text', id: 'md-send', sessionID: 's', messageID: 'm', text: content }],
  } });
  try {
    await act(async () => root.render(
      <I18nProvider><ThemeSystemProvider>
        <MarkdownContent key="markdown-send" content={content} directory="/repo" enableFileReferences={false}
          openuiOwner={{ sessionId: 's', messageId: 'm', partId: 'md-send' }} />
      </ThemeSystemProvider></I18nProvider>,
    ));
    for (let index = 0; index < 2; index++) {
      await act(async () => {
        host.querySelector('button')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(send).toHaveBeenCalledTimes(index + 1);
      expect(host.querySelector('button')?.disabled).toBe(false);
    }
    expect(requests.filter((url) => url.includes('/openui'))).toEqual([]);
    expect(useInputStore.getState().pendingInputText).toBe('Keep the composer');
  } finally {
    send.mockRestore();
  }
});

test('the production Markdown seam activates only canonical closed assistant fences', async () => {
  const source = 'root = Stack([Input("choice", null, "text", null, "Original")])';
  const fence = `\`\`\`openui-lang\n${source}\n\`\`\``;
  const draw = async (content: string, canonicalContent = content, purpose?: 'copy') => {
    stores.ensureChild('/repo').setState({ part: {
      message: [{ type: 'text', id: 'part', sessionID: 'md', messageID: 'message', text: canonicalContent }],
    } });
    await act(async () => {
      root.render(
        <I18nProvider><ThemeSystemProvider>
          <MarkdownContent key="markdown" content={content} canonicalContent={canonicalContent}
            mode="streaming" purpose={purpose} enableFileReferences={false} directory="/repo"
            openuiOwner={{ sessionId: 'md', messageId: 'message', partId: 'part' }} />
        </ThemeSystemProvider></I18nProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await draw(fence.slice(0, -3));
  expect(host.querySelector('input')).toBeNull();
  await draw(fence);
  const input = host.querySelector('input');
  expect(input?.value).toBe('Original');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing Markdown-generated input');
  await act(async () => {
    setter.call(input, 'Kept');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await draw(`${fence}\n\nMore prose.`);
  expect(host.querySelector('input')).toBe(input);
  expect(input.value).toBe('Kept');
  await draw(fence, fence.replace('Original', 'Replaced'));
  expect(host.querySelector('input')).toBeNull();
  await draw(fence.replace('openui-lang', 'openui-lang literal'));
  expect(host.querySelector('input')).toBeNull();
  await draw(fence, fence, 'copy');
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).toContain(source);
});

test('canonical deltas ahead of the displayed Markdown retain the completed UI and field node', async () => {
  const source = 'root = Stack([Input("streamed", null, "text", null, "Original")])';
  const fence = `\`\`\`openui-lang\n${source}\n\`\`\`\n\n`;
  const draw = async (content: string, canonicalContent: string) => {
    stores.ensureChild('/repo').setState({ part: {
      flicker: [{ type: 'text', id: 'flicker-part', sessionID: 's', messageID: 'flicker', text: canonicalContent }],
    } });
    await act(async () => {
      root.render(
        <I18nProvider><ThemeSystemProvider>
          <MarkdownContent key="flicker" content={content} canonicalContent={canonicalContent}
            mode="streaming" isStreaming enableFileReferences={false} directory="/repo"
            openuiOwner={{ sessionId: 's', messageId: 'flicker', partId: 'flicker-part' }} />
        </ThemeSystemProvider></I18nProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await draw(fence, fence);
  const input = host.querySelector('input');
  expect(input?.value).toBe('Original');
  for (const tail of ['More', 'More text', 'More text.\n\nNext paragraph']) {
    await draw(fence, fence + tail);
    expect(host.querySelector('input') === input).toBe(true);
    expect(host.querySelector('[data-streamdown="code-block"]')).toBeNull();
  }
  await draw(fence + 'More text.\n\nNext paragraph', fence + 'More text.\n\nNext paragraph');
  expect(host.querySelector('input') === input).toBe(true);
});

test('enabling OpenUI on unchanged Markdown reuses display positions', async () => {
  const content = 'Before.\n\n```openui-lang\nroot = Stack([Input("name", null, "text", null, "Alice")])\n```\n\n';
  stores.ensureChild('/repo').setState({ part: {
    toggle: [{ type: 'text', id: 'toggle-part', sessionID: 's', messageID: 'toggle', text: content }],
  } });
  await act(async () => useUIStore.setState({ agentRenderToolEnabled: false }));
  try {
    await act(async () => root.render(
      <I18nProvider><ThemeSystemProvider>
        <MarkdownContent key="toggle" content={content} mode="streaming" isStreaming directory="/repo"
          enableFileReferences={false} openuiOwner={{ sessionId: 's', messageId: 'toggle', partId: 'toggle-part' }} />
      </ThemeSystemProvider></I18nProvider>,
    ));
    expect(host.querySelector('input')).toBeNull();
    await act(async () => useUIStore.setState({ agentRenderToolEnabled: true }));
    expect(host.querySelector('input')?.value).toBe('Alice');
    expect(host.querySelector('pre')).toBeNull();
    await act(async () => useUIStore.setState({ agentRenderToolEnabled: false }));
    expect(host.querySelector('input')).toBeNull();
    await act(async () => useUIStore.setState({ agentRenderToolEnabled: true }));
    expect(host.querySelector('input')?.value).toBe('Alice');
  } finally {
    await act(async () => useUIStore.setState({ agentRenderToolEnabled: true }));
  }
});

test('legal closing-line growth retains preview until canonical confirms completion', async () => {
  const content = '```openui-lang\nroot = Stack([Input("name", null, "text", null, "Alice")])\n```';
  const draw = async (canonicalContent: string, displayed = content, isStreaming = true) => {
    stores.ensureChild('/repo').setState({ part: {
      close: [{ type: 'text', id: 'close-part', sessionID: 's', messageID: 'close', text: canonicalContent }],
    } });
    await act(async () => root.render(
      <I18nProvider><ThemeSystemProvider>
        <MarkdownContent key="close" content={displayed} canonicalContent={canonicalContent} mode="streaming"
          isStreaming={isStreaming} directory="/repo" enableFileReferences={false}
          openuiOwner={{ sessionId: 's', messageId: 'close', partId: 'close-part' }} />
      </ThemeSystemProvider></I18nProvider>,
    ));
  };
  await draw(content);
  const input = host.querySelector('input');
  expect(input?.disabled).toBe(true);
  for (const suffix of ['`', '` ', '` \n']) {
    await draw(content + suffix);
    expect(host.querySelector('input') === input).toBe(true);
    expect(host.querySelector('pre')).toBeNull();
    expect(input?.disabled).toBe(!suffix.endsWith('\n'));
  }
  await draw(content + '` \n', content + '` \n');
  expect(host.querySelector('input') === input).toBe(true);
  expect(input?.disabled).toBe(false);
  await draw(content + '` \n', content + '` \n', false);
  expect(host.querySelector('input') === input).toBe(true);
});

test('Callout receives its full dismissal interval after streaming ends', async () => {
  const source = 'root = Stack([Callout("info", "Streaming notice", "Details", $visible)])\n$visible = true';
  const draw = async (isStreaming: boolean) => act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="callout-stream" source={source} isStreaming={isStreaming}
        owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'callout' }}
        renderKey="callout-stream" canInteract={() => true} repeatable submit={async () => {}} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  await draw(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3100)); });
  expect(host.textContent).toContain('Streaming notice');
  await draw(false);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(host.textContent).toContain('Streaming notice');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3000)); });
  expect(host.textContent).not.toContain('Streaming notice');
}, 10000);

test('OpenUI streams forward references and partial text through one renderer until the authored fence closes', async () => {
  const owner = { sessionId: 's', messageId: 'stream', partId: 'stream-part' };
  const prefix = 'Before.\n\n```openui-lang\n';
  const first = 'root = Stack([TextContent("First"), Input("name", null, "text", null, "Original"), later])\n';
  const draw = async (body: string, closed = false) => {
    const content = prefix + body + (closed ? '\n```\n\nAfter.' : '');
    stores.ensureChild('/repo').setState({ part: {
      stream: [{ type: 'text', id: owner.partId, sessionID: owner.sessionId, messageID: owner.messageId, text: content }],
    } });
    await act(async () => {
      root.render(
        <I18nProvider><ThemeSystemProvider>
          <MarkdownContent key="stream" content={content} mode="streaming" isStreaming
            enableFileReferences={false} directory="/repo" openuiOwner={owner} />
        </ThemeSystemProvider></I18nProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await draw(first);
  expect(host.textContent).toContain('First');
  expect(host.querySelector('pre')).toBeNull();
  const input = host.querySelector('input');
  expect(input).not.toBeNull();
  expect(input?.disabled).toBe(true);
  await draw(first + 'later = TextContent("Sec');
  expect(host.textContent).toContain('Sec');
  expect(host.querySelector('input') === input).toBe(true);
  expect(host.querySelector('pre')).toBeNull();
  await draw(first + 'later = TextContent("Second")', true);
  expect(host.textContent).toContain('Second');
  expect(host.querySelector('input') === input).toBe(true);
  expect(input?.disabled).toBe(false);
});

test('a streaming program cannot submit or mount HtmlView, and a completed program recovers from prior errors', async () => {
  const owner = { runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'restricted-stream' };
  let calls = 0;
  const draw = async (source: string, isStreaming: boolean) => act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="restricted-stream" source={source} isStreaming={isStreaming}
        owner={owner} renderKey="restricted-stream" canInteract={() => true} repeatable
        submit={async () => { calls++; }} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  const source = 'root = Stack([Button("Submit stream", @ToAssistant("Use value")), HtmlView("<p>Pending</p>")])';
  await draw(source, true);
  const button = host.querySelector('button');
  expect(button?.disabled).toBe(true);
  expect(host.querySelector('iframe') === null).toBe(true);
  await act(async () => { button?.click(); });
  expect(calls).toBe(0);
  await draw('root = Stack([Unknown("Invalid")])', false);
  expect(host.querySelector('pre') !== null).toBe(true);
  await draw('root = Stack([TextContent("Recovered")])', true);
  expect(host.textContent).toContain('Recovered');
  await draw('root = Stack([TextContent("Recovered")])', false);
  expect(host.querySelector('pre') === null).toBe(true);
});

test('OpenUI keeps its renderer through token-sized chunks, display lag, a second fence and settlement', async () => {
  const { resolveAssistantDisplayText } = await import('./message/parts/assistantTextVisibility');
  const owner = { sessionId: 's', messageId: 'tokens', partId: 'tokens-part' };
  const prefix = 'Intro.\n\n```openui-lang\nroot = Stack([Input("name", null, "text", null, "Original"), body])\n';
  let field: HTMLInputElement | null = null;
  const draw = async (canonicalContent: string, displayed = canonicalContent, isStreaming = true) => {
    stores.ensureChild('/repo').setState({ part: {
      tokens: [{ type: 'text', id: owner.partId, sessionID: owner.sessionId, messageID: owner.messageId, text: canonicalContent }],
    } });
    const display = resolveAssistantDisplayText({
      textContent: canonicalContent, throttledTextContent: displayed, isStreaming, allowOpenUI: true,
    });
    await act(async () => {
      root.render(
        <I18nProvider><ThemeSystemProvider>
          <MarkdownContent key="tokens" content={display.content} openuiSource={display.openuiSource} canonicalContent={canonicalContent}
            mode="streaming" isStreaming={isStreaming} enableFileReferences={false} directory="/repo" openuiOwner={owner} />
        </ThemeSystemProvider></I18nProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!field) field = host.querySelector('input');
    expect(field !== null && host.querySelector('input') === field).toBe(true);
    expect(host.querySelector('[data-oc-openui-source] pre') === null).toBe(true);
  };
  await draw(prefix);
  const suffix = 'body = TextContent("Streaming **text**")\n```\n\nMore prose.\n\n```openui-lang\nroot = Stack([TextContent("Next UI")])\n```\n\nTail.';
  for (let end = 1; end <= suffix.length; end++) {
    const previous = prefix + suffix.slice(0, end - 1);
    const current = prefix + suffix.slice(0, end);
    await draw(current, previous);
    await draw(current);
  }
  await draw(prefix + suffix, prefix + suffix, false);
  expect(host.textContent).toContain('Next UI');
  expect(host.querySelector('input')?.disabled).toBe(false);
}, 15000);

test('native delivery includes the selected form, not a second form or its snapshot', async () => {
  const source = `root = Stack([first, second])
first = Form("first", Buttons([Button("Choose first", @ToAssistant("Use first"))]), [FormControl("First name", Input("name", null, "text", null, "Alice"))])
second = Form("second", Buttons([Button("Choose second", @ToAssistant("Use second"))]), [FormControl("Other name", Input("name", null, "text", null, "Private"))])`;
  const answers: OpenUISubmission[] = [];
  await act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="scoped" source={source}
        owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'scoped' }}
        renderKey="scoped" canInteract={() => true} repeatable={false} submit={async (answer) => { answers.push(answer); }} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  await act(async () => {
    Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Choose first')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ summary: 'Use first', data: { formName: 'first', formValues: { name: 'Alice' } } });
  expect(JSON.stringify(answers)).not.toContain('Private');
});

test('unscoped delivery includes standalone fields without leaking another form', async () => {
  const source = `root = Stack([Input("standalone", null, "text", null, "Visible"), other, Buttons([Button("Continue", @ToAssistant("Continue"))])])
other = Form("other", Buttons([]), [FormControl("Private field", Input("private", null, "text", null, "Private"))])`;
  const answers: OpenUISubmission[] = [];
  await act(async () => root.render(
    <I18nProvider><ThemeSystemProvider>
      <OpenUIProgram key="unscoped" source={source}
        owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'unscoped' }}
        renderKey="unscoped" canInteract={() => true} repeatable={false} submit={async (answer) => { answers.push(answer); }} />
    </ThemeSystemProvider></I18nProvider>,
  ));
  await act(async () => {
    Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Continue')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(answers[0]).toMatchObject({ data: { formValues: { standalone: 'Visible' } } });
  expect(JSON.stringify(answers)).not.toContain('Private');
});

test('edited ordinary fields deliver plain values inside and outside a form', async () => {
  for (const scoped of [false, true]) {
    const answers: OpenUISubmission[] = [];
    const input = 'Input("name", null, "text", null, "Alice")';
    const buttons = 'Buttons([Button("Deliver", @ToAssistant("Use edited value"))])';
    const source = scoped
      ? `root = Stack([Form("prefs", ${buttons}, [FormControl("Name", ${input})])])`
      : `root = Stack([${input}, ${buttons}])`;
    await act(async () => root.render(
      <I18nProvider><ThemeSystemProvider>
        <OpenUIProgram key={`edited-${scoped}`} source={source}
          owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'edited' }}
          renderKey={`edited-${scoped}`} canInteract={() => true} repeatable={false} submit={async (answer) => { answers.push(answer); }} />
      </ThemeSystemProvider></I18nProvider>,
    ));
    const field = host.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
    if (!field || !setter) throw new Error('Missing ordinary field');
    await act(async () => {
      setter.call(field, 'Bob');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(answers).toHaveLength(1);
    expect(answers[0].data).toMatchObject({ formValues: { name: 'Bob' } });
  }
});

test('the production program preserves entered values on submission failure', async () => {
  const source = `root = Stack([form])
$name = "Alice"
form = Form("prefs", Buttons([Button("Send", @ToAssistant("Use name"))]), [FormControl("Name", Input("name", null, "text", null, $name))])`;
  let calls = 0;
  await act(async () => root.render(
    <I18nProvider>
      <ThemeSystemProvider>
        <OpenUIProgram
          source={source}
          owner={{ runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'p' }}
          renderKey="revision"
          canInteract={() => true}
          repeatable={false}
          submit={async () => { calls++; throw new Error('refused'); }}
        />
      </ThemeSystemProvider>
    </I18nProvider>,
  ));
  const input = host.querySelector('input');
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Missing generated input');
  await act(async () => {
    setter.call(input, 'Bob');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('Bob');
  await act(async () => {
    host.querySelector('button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).toBe(1);
  expect(input.value).toBe('Bob');
  expect(host.textContent).toContain('Your input has been kept.');
  await act(async () => {
    host.querySelector('button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).toBe(2);
  expect(host.querySelector('input')).toBe(input);
  expect(input.value).toBe('Bob');
});
