import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  ClipboardEvent: dom.ClipboardEvent,
  DataTransfer: dom.DataTransfer,
  File: dom.File,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { useCommentImagePaste } = await import('./useCommentImagePaste');
const { useInputStore } = await import('@/sync/input-store');
const { I18nProvider } = await import('@/lib/i18n');

const originalAddAttachedFile = useInputStore.getState().addAttachedFile;
let attachedNames: string[] = [];
let commentText = '';
let attach: (text: string) => Promise<void> = async () => {};

const Harness = () => {
  const [text, setText] = React.useState('Look at ');
  const { takePastedImages, attachCitedImages } = useCommentImagePaste();
  commentText = text;
  attach = attachCitedImages;
  return (
    <textarea
      value={text}
      onChange={(event) => setText(event.target.value)}
      onPaste={(event) => {
        const pasted = takePastedImages(event);
        if (pasted) setText(pasted.text);
      }}
    />
  );
};

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
const textarea = host.querySelector('textarea');
if (!textarea) throw new Error('harness textarea did not render');

const pasteImage = async (name: string) => {
  const data = new DataTransfer();
  data.items.add(new File(['png'], name, { type: 'image/png' }));
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  await act(async () => {
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  attachedNames = [];
  useInputStore.setState({
    attachedFiles: [],
    addAttachedFile: async (file: File) => {
      attachedNames.push(file.name);
      return true;
    },
  });
});

afterAll(() => {
  act(() => root.unmount());
  useInputStore.setState({ addAttachedFile: originalAddAttachedFile });
});

describe('useCommentImagePaste', () => {
  test('a pasted image is cited in the comment and attached once the comment is', async () => {
    await pasteImage('image.png');
    expect(commentText).toBe('Look at [image-1.png]');
    expect(attachedNames).toEqual([]);

    await attach(commentText);
    expect(attachedNames).toEqual(['image-1.png']);
  });

  test('an image whose citation was deleted is not attached', async () => {
    await pasteImage('image.png');
    await pasteImage('image.png');
    expect(commentText).toContain('[image-1.png]');
    expect(commentText).toContain('[image-2.png]');

    await attach(commentText.replaceAll('[image-1.png]', ''));
    expect(attachedNames).toEqual(['image-2.png']);
  });
});
