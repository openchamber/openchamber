import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { MessageFilesDisplay } = await import('./FileAttachment');
import type { FilePart } from '@/lib/opencode/model';
import type { ToolPopupContent } from './message/types';

/** Build the same base64 data URL shape `fileAttachmentUrl` produces. */
const textDataUrl = (text: string, mime = 'text/plain'): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
};

let fileSeq = 0;
const file = (overrides: Partial<FilePart> = {}): FilePart => {
  fileSeq += 1;
  return {
    id: `file-${fileSeq}`,
    sessionID: 'session',
    messageID: 'message',
    type: 'file',
    mime: 'text/plain',
    filename: 'pasted-context-1.txt',
    url: textDataUrl('hello pasted world'),
    ...overrides,
  };
};

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
let popups: ToolPopupContent[] = [];

const renderFiles = async (files: FilePart[], compact: boolean) => {
  popups = [];
  const onShowPopup = (popup: ToolPopupContent) => {
    popups.push(popup);
  };
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <MessageFilesDisplay files={files} onShowPopup={onShowPopup} compact={compact} />
        </TooltipProvider>
      </I18nProvider>,
    );
  });
};

const clickChip = async (chip: Element) => {
  await act(async () => {
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

afterAll(async () => {
  await act(async () => root.unmount());
  browser.close();
});

describe('MessageFilesDisplay pasted text files', () => {
  test('a non-compact text chip opens the popup with the decoded content', async () => {
    await renderFiles([file()], false);

    const chip = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('pasted-context-1.txt'));
    expect(chip).toBeDefined();
    await clickChip(chip!);

    expect(popups).toHaveLength(1);
    expect(popups[0].open).toBe(true);
    expect(popups[0].title).toBe('pasted-context-1.txt');
    expect(popups[0].content).toBe('hello pasted world');
    expect(popups[0].image).toBeUndefined();
  });

  test('a compact text chip is clickable and opens the same popup', async () => {
    await renderFiles([file()], true);

    const chip = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('pasted-context-1.txt'));
    expect(chip).toBeDefined();
    await clickChip(chip!);

    expect(popups).toHaveLength(1);
    expect(popups[0].content).toBe('hello pasted world');
    expect(popups[0].image).toBeUndefined();
  });

  test('multibyte content survives the data URL decode', async () => {
    const content = 'héllo 模板 — second line';
    await renderFiles([file({ url: textDataUrl(content) })], false);

    const chip = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('pasted-context-1.txt'));
    await clickChip(chip!);

    expect(popups[0].content).toBe(content);
  });

  test('a compact image thumbnail keeps the image popup payload', async () => {
    await renderFiles([file({ mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,aGVsbG8=' })], true);

    const chip = [...container.querySelectorAll('button')].find((entry) => entry.getAttribute('aria-label') === 'shot.png');
    expect(chip).toBeDefined();
    await clickChip(chip!);

    expect(popups).toHaveLength(1);
    expect(popups[0].content).toBe('');
    expect(popups[0].image?.url).toBe('data:image/png;base64,aGVsbG8=');
    expect(popups[0].image?.mimeType).toBe('image/png');
  });

  test('a pdf chip keeps today\'s behavior', async () => {
    await renderFiles([file({ mime: 'application/pdf', filename: 'doc.pdf', url: 'data:application/pdf;base64,aGVsbG8=' })], false);

    const chip = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('doc.pdf'));
    expect(chip).toBeDefined();
    await clickChip(chip!);

    expect(popups).toHaveLength(1);
    expect(popups[0].content).toBe('');
    expect(popups[0].image?.filename).toBe('doc.pdf');
  });

  test('a compact pdf chip stays a non-clickable chip', async () => {
    await renderFiles([file({ mime: 'application/pdf', filename: 'doc.pdf', url: 'data:application/pdf;base64,aGVsbG8=' })], true);

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.find((entry) => entry.textContent?.includes('doc.pdf'))).toBeUndefined();
    expect(container.textContent).toContain('doc.pdf');
  });
});
