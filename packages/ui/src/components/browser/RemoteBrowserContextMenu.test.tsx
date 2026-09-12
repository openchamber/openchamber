import { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { dom, mountCanvas } from './RemoteBrowserCanvas.test-support';

const { I18nProvider } = await import('@/lib/i18n');
const { RemoteBrowserCanvas } = await import('./RemoteBrowserCanvas');

const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, 'clipboard');
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(dom.navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(dom.navigator, 'clipboard');
});
const setClipboard = (clipboard: Partial<Clipboard>) => Object.defineProperty(dom.navigator, 'clipboard', { configurable: true, value: clipboard });

const requestSchema = z.object({ type: z.literal('contextMenu'), requestId: z.string(),
  tabId: z.string(), attachmentRequestId: z.string(), x: z.number(), y: z.number() });
const requestFor = (sent: readonly string[]) => {
  for (const raw of sent) {
    const parsed = requestSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  }
  throw new Error('Expected a remote context request');
};
const requestMenu = async (fixture: Awaited<ReturnType<typeof mountCanvas>>) => {
  await act(async () => {
    fixture.canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 170, clientY: 130,
    }));
  });
  return requestFor(fixture.socket.sent);
};
const answerMenu = async (fixture: Awaited<ReturnType<typeof mountCanvas>>, status: 'menu' | 'page-handled' | 'unavailable') => {
  const request = requestFor(fixture.socket.sent);
  await act(async () => {
    fixture.socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'contextMenuResult', status }) });
  });
};
const itemNamed = (label: string) => {
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => candidate.textContent === label);
  if (!(item instanceof HTMLElement)) throw new Error(`Expected menu item ${label}`);
  return item;
};
const mountInsidePanel = async (fixture: Awaited<ReturnType<typeof mountCanvas>>, onKeyDownCapture: (key: string) => void) => {
  await act(async () => {
    fixture.root.render(<div onKeyDownCapture={(event) => onKeyDownCapture(event.key)}>
      <button type="button">Panel key target</button>
      <I18nProvider><RemoteBrowserCanvas client={fixture.client} activeTabId="sc:target" enabled
        onFrameFailure={() => undefined} /></I18nProvider>
    </div>);
  });
  const canvas = fixture.host.querySelector('canvas');
  const keyTarget = Array.from(fixture.host.querySelectorAll('button')).find((candidate) => candidate.textContent === 'Panel key target');
  if (!canvas || !keyTarget) throw new Error('Expected the re-mounted canvas and panel key target');
  const captured = new Set<number>();
  Object.defineProperties(canvas, {
    getContext: { value: () => ({ drawImage() {} }) },
    getBoundingClientRect: { value: () => new dom.DOMRect(20, 30, 500, 250) },
    setPointerCapture: { value: (id: number) => { captured.add(id); } },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: (id: number) => { captured.delete(id); } },
  });
  await act(async () => {
    fixture.socket.onmessage?.({ data: JSON.stringify({
      type: 'frame', frameSeq: 2, streamGen: 1, tabId: 'sc:target', width: 1000, height: 500, scale: 2,
    }) });
    fixture.socket.onmessage?.({ data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer });
  });
  fixture.socket.sent.length = 0;
  return { canvas, keyTarget };
};
const dispatchKey = async (target: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init });
  await act(async () => { target.dispatchEvent(event); });
  return event;
};

describe('RemoteBrowserContextMenu', () => {
  test('requests one remote context click and waits for the page before showing browser actions', async () => {
    const fixture = await mountCanvas();
    await act(async () => {
      for (const type of ['pointerdown', 'pointerup']) fixture.canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 2, button: 2, clientX: 170, clientY: 130,
      }));
    });
    const request = await requestMenu(fixture);

    expect(fixture.socket.sent.map((raw) => JSON.parse(raw))).toEqual([request]);
    expect({ tabId: request.tabId, x: request.x, y: request.y }).toEqual({ tabId: 'sc:target', x: 300, y: 200 });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await answerMenu(fixture, 'menu');

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(itemNamed('Back').getAttribute('aria-disabled')).toBe('true');
    expect(itemNamed('Forward').getAttribute('aria-disabled')).toBe('true');
    expect(itemNamed('Reload')).not.toBeNull();
    expect(itemNamed('Copy')).not.toBeNull();
    expect(itemNamed('Paste')).not.toBeNull();
  });

  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    test(`keeps ${modifier === 'ctrlKey' ? 'Ctrl' : 'Command'} shortcuts out of the host while the remote context menu is open`, async () => {
      // Given the portaled remote browser menu is open and the host listens for application shortcuts.
      const fixture = await mountCanvas();
      await requestMenu(fixture);
      await answerMenu(fixture, 'menu');
      const menuItem = modifier === 'ctrlKey' ? itemNamed('Paste') : itemNamed('Reload');
      const menu = menuItem.closest('[role="menu"]');
      if (!(menu instanceof HTMLElement)) throw new Error('Expected the remote browser menu');
      let hostShortcutCount = 0;
      let localNavigationCount = 0;
      const hostShortcut = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() === 'p' && event[modifier]) hostShortcutCount += 1;
      };
      const localNavigation = (event: Event) => {
        if (event instanceof KeyboardEvent && event.key === 'ArrowUp') localNavigationCount += 1;
      };
      window.addEventListener('keydown', hostShortcut);
      menu.addEventListener('keydown', localNavigation);
      try {
        // When the user presses Chrome's print shortcut from the menu.
        await dispatchKey(menuItem, 'p', { [modifier]: true });
      } finally {
        window.removeEventListener('keydown', hostShortcut);
        menu.removeEventListener('keydown', localNavigation);
      }

      // Then the shortcut remains within the remote browser interaction boundary.
      expect(hostShortcutCount).toBe(0);
      expect(localNavigationCount).toBe(modifier === 'ctrlKey' ? 1 : 0);
    });
  }

  for (const status of ['page-handled', 'unavailable'] as const) {
    test(`preserves page content when the server reports ${status}`, async () => {
      const fixture = await mountCanvas();
      await requestMenu(fixture);

      await answerMenu(fixture, status);

      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(fixture.host.querySelector('[role="status"]') !== null).toBe(status === 'unavailable');
    });
  }

  for (const dismissal of ['pointer', 'wheel', 'escape', 'tab'] as const) {
    test(`does not reopen a delayed response after ${dismissal}`, async () => {
      const fixture = await mountCanvas();
      await requestMenu(fixture);

      await act(async () => {
        switch (dismissal) {
          case 'pointer': fixture.canvas.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, pointerType: 'mouse', pointerId: 3, button: 0, clientX: 170, clientY: 130,
          })); break;
          case 'wheel': fixture.canvas.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: 40, clientX: 170, clientY: 130,
          })); break;
          case 'escape': document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })); break;
          case 'tab': fixture.client.attachTab('sc:other'); break;
        }
      });
      await answerMenu(fixture, 'menu');

      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(fixture.host.querySelector('[role="status"]')).toBeNull();
    });
  }

  test('owns Escape while the fallback menu is pending or open without swallowing ordinary Escape or Tab', async () => {
    const fixture = await mountCanvas();
    const panelKeys: string[] = [];
    const panel = await mountInsidePanel(fixture, (key) => { panelKeys.push(key); });
    const panelFixture = { ...fixture, canvas: panel.canvas };

    await requestMenu(panelFixture);
    const pendingEscape = await dispatchKey(panel.keyTarget, 'Escape');

    expect(panelKeys).toEqual([]);
    expect(pendingEscape.defaultPrevented).toBe(true);
    await answerMenu(panelFixture, 'menu');
    expect(document.querySelector('[role="menu"]')).toBeNull();

    fixture.socket.sent.length = 0;
    await requestMenu(panelFixture);
    await answerMenu(panelFixture, 'menu');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const openEscape = await dispatchKey(panel.keyTarget, 'Escape');

    expect(panelKeys).toEqual([]);
    expect(openEscape.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    fixture.socket.sent.length = 0;
    await requestMenu(panelFixture);
    await answerMenu(panelFixture, 'menu');
    await dispatchKey(panel.keyTarget, 'Tab');

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(panelKeys).toEqual(['Tab']);
    const ordinaryEscape = await dispatchKey(panel.keyTarget, 'Escape');
    expect(panelKeys).toEqual(['Tab', 'Escape']);
    expect(ordinaryEscape.defaultPrevented).toBe(false);
  });

  test('reloads through the current remote navigation action', async () => {
    const fixture = await mountCanvas();
    await requestMenu(fixture);
    await answerMenu(fixture, 'menu');
    fixture.socket.sent.length = 0;

    await act(async () => itemNamed('Reload').click());

    expect(fixture.socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: 'reload', tabId: 'sc:target' }]);
  });

  for (const [label, action] of [['Back', 'back'], ['Forward', 'forward']] as const) {
    test(`runs ${action} only when authoritative history allows it`, async () => {
      const fixture = await mountCanvas();
      await act(async () => fixture.socket.onmessage?.({ data: JSON.stringify({ type: 'navigation', tabId: 'sc:target',
        url: 'https://example.test/', title: 'Page', canGoBack: true, canGoForward: true, isLoading: false }) }));
      await requestMenu(fixture);
      await answerMenu(fixture, 'menu');
      fixture.socket.sent.length = 0;

      await act(async () => itemNamed(label).click());

      expect(fixture.socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: action, tabId: 'sc:target' }]);
    });
  }

  test('copies the remote selection through the existing clipboard exchange', async () => {
    const writes: string[] = [];
    setClipboard({ write: async (items) => { writes.push(await (await items[0].getType('text/plain')).text()); } });
    const fixture = await mountCanvas();
    await requestMenu(fixture);
    await answerMenu(fixture, 'menu');
    fixture.socket.sent.length = 0;

    await act(async () => itemNamed('Copy').click());
    const request = z.object({ type: z.literal('copy'), requestId: z.string(), tabId: z.string() })
      .parse(JSON.parse(fixture.socket.sent.at(-1) ?? 'null'));
    await act(async () => fixture.socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: true, text: 'selected text' }) }));

    expect(writes).toEqual(['selected text']);
  });

  test('pastes plain text through the existing focused-page input path', async () => {
    setClipboard({ readText: async () => 'paste this text' });
    const fixture = await mountCanvas();
    await requestMenu(fixture);
    await answerMenu(fixture, 'menu');
    fixture.socket.sent.length = 0;

    await act(async () => itemNamed('Paste').click());

    expect(fixture.socket.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: 'text', tabId: 'sc:target', text: 'paste this text' }]);
  });

  test('opens DevTools through the pane callback', async () => {
    let opened = 0;
    const fixture = await mountCanvas({ onOpenDevTools: () => { opened += 1; } });
    await requestMenu(fixture);
    await answerMenu(fixture, 'menu');

    await act(async () => itemNamed('Open Chrome DevTools').click());

    expect(opened).toBe(1);
  });
});
