import React, { act } from 'react';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { toast } from 'sonner';

import { I18nProvider } from '@/lib/i18n';
import type { TextPart } from '@/lib/opencode/model';
import { useAssistantMarkdownSave } from './useAssistantMarkdownSave';

const saveFileState: { impl: (file: File) => Promise<void> } = {
  impl: async () => {},
};
mock.module('../parts/saveFile', () => ({
  saveFile: (file: File) => saveFileState.impl(file),
}));

type HarnessProps = {
  messageId: string;
  earlierAssistantText?: string[];
  assistantTextParts: TextPart[];
  onSave: (save: () => Promise<void>) => void;
};

const Harness: React.FC<HarnessProps> = ({ messageId, earlierAssistantText, assistantTextParts, onSave }) => {
  const { saveTurnAsMarkdown } = useAssistantMarkdownSave({ messageId, earlierAssistantText, assistantTextParts });
  onSave(saveTurnAsMarkdown);
  return null;
};

const originals = new Map<string, PropertyDescriptor | undefined>();
let root: ReturnType<typeof createRoot> | undefined;
let container: Element | undefined;
const spies: { mockRestore: () => void }[] = [];

const setup = async (props: Omit<HarnessProps, 'onSave'>) => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    Event: dom.Event,
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const successToast = spyOn(toast, 'success').mockImplementation(() => 'success');
  const errorToast = spyOn(toast, 'error').mockImplementation(() => 'error');
  spies.push(successToast, errorToast);
  let save: () => Promise<void> = async () => {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider>
        <Harness {...props} onSave={(next) => { save = next; }} />
      </I18nProvider>,
    );
  });
  return {
    invoke: () => act(async () => { await save(); }),
    successToast,
    errorToast,
  };
};

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  for (const spy of spies.splice(0)) spy.mockRestore();
  root = undefined;
  container = undefined;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  originals.clear();
});

const textPart = (text: string): TextPart => ({ type: 'text', id: 'part', text, sessionID: 'session', messageID: 'message' });

test('a failed save reports an error toast and no success toast', async () => {
  const saved: File[] = [];
  const { invoke, successToast, errorToast } = await setup({
    messageId: 'm1',
    assistantTextParts: [textPart('Hello **world**')],
  });
  saveFileState.impl = async (file: File) => {
    saved.push(file);
    throw new Error('File sharing is unavailable in this mobile runtime');
  };

  await invoke();

  expect(saved).toHaveLength(1);
  expect(await saved[0]?.text()).toBe('Hello **world**');
  expect(successToast.mock.calls).toHaveLength(0);
  expect(errorToast.mock.calls).toHaveLength(1);
  expect(errorToast.mock.calls[0]?.[0]).toBe('Failed to save Markdown');
});

test('a dismissed share sheet stays silent', async () => {
  const { invoke, successToast, errorToast } = await setup({
    messageId: 'm1',
    assistantTextParts: [textPart('Hello')],
  });
  saveFileState.impl = async () => {
    throw new DOMException('The user aborted a request', 'AbortError');
  };

  await invoke();

  expect(successToast.mock.calls).toHaveLength(0);
  expect(errorToast.mock.calls).toHaveLength(0);
});

test('a successful save passes a markdown file and toasts success', async () => {
  const saved: File[] = [];
  const { invoke, successToast, errorToast } = await setup({
    messageId: 'm1',
    assistantTextParts: [textPart('Hello **world**')],
  });
  saveFileState.impl = async (file: File) => { saved.push(file); };

  await invoke();

  expect(saved).toHaveLength(1);
  expect(saved[0]?.name).toBe('message-m1.md');
  expect(saved[0]?.type).toBe('text/markdown');
  expect(await saved[0]?.text()).toBe('Hello **world**');
  expect(successToast.mock.calls[0]?.[0]).toBe('Markdown saved');
  expect(errorToast.mock.calls).toHaveLength(0);
});
