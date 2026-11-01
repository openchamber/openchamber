import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, Node: dom.Node, Event: dom.Event });

const { registerCloseTabTarget } = await import('./closeTabTarget');

const element = (parent: Element = document.body, zone?: string): HTMLElement => {
  const child = document.createElement('div');
  if (zone) child.dataset.contextZone = zone;
  parent.append(child);
  return child;
};
const closeTab = (): void => {
  window.dispatchEvent(new Event('openchamber:close-tab'));
};

describe('close tab target', () => {
  test('Cmd/Ctrl+W reaches the most recently registered surface, then the one before it', () => {
    const closed: string[] = [];
    const releaseFirst = registerCloseTabTarget(() => closed.push('first'), { current: null });
    const releaseSecond = registerCloseTabTarget(() => closed.push('second'), { current: null });

    closeTab();
    releaseSecond();
    closeTab();
    releaseFirst();
    closeTab();

    expect(closed).toEqual(['second', 'first']);
  });

  test('Cmd/Ctrl+W closes the tab in the zone the user clicked last, whichever registered last', () => {
    const leftZone = element(document.body, 'left');
    const rightZone = element(document.body, 'right');
    const chat = element();
    const editor = element(element(leftZone));
    const browserTabStrip = element(rightZone);
    const webview = element(element(rightZone));
    const closed: string[] = [];
    const releaseBrowser = registerCloseTabTarget(() => closed.push('browser'), { current: rightZone });
    const releaseEditor = registerCloseTabTarget(() => closed.push('file'), { current: editor });

    // A click on the right zone's tab strip counts for the browser tab there.
    browserTabStrip.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    closeTab();
    // A click in the left zone, outside the editor's own element, counts for the file.
    leftZone.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    closeTab();
    // A click on the chat changes nothing: the last used surface still wins.
    chat.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    closeTab();
    // A click into a page only focuses its webview, with a `focus` event that does not bubble.
    webview.dispatchEvent(new Event('focus'));
    closeTab();

    expect(closed).toEqual(['browser', 'file', 'file', 'browser']);
    releaseBrowser();
    releaseEditor();
  });

  test('a target on the whole page takes the clicks outside the zones and leaves the zones theirs', () => {
    const rightZone = element(document.body, 'right');
    const terminal = element(rightZone);
    const notes = element(element(document.body, 'left'));
    const chat = element();
    const closed: string[] = [];
    const releaseSessions = registerCloseTabTarget(() => closed.push('session'), { current: document.body });
    const releaseTerminal = registerCloseTabTarget(() => closed.push('terminal'), { current: terminal });

    chat.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    closeTab();
    terminal.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    closeTab();
    // A zone with no tabs of its own counts for the sessions.
    notes.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    closeTab();

    expect(closed).toEqual(['session', 'terminal', 'session']);
    releaseSessions();
    releaseTerminal();
  });
});
