import { EditorView } from '@codemirror/view';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import {
  formatCodeSelectionMarkdown,
  rangeToMarkdown,
  trimSelectionValue,
  wrapMarkdownSelectionForChat,
} from '@/components/chat/message/selectionMarkdown';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';

const CHAT_INPUT_HOST_SELECTOR = '[data-chat-input="true"]';

const isInsideChatComposer = (node: Node | null): boolean => {
  if (!node) {
    return false;
  }
  const asElement = node as Element;
  const element = typeof asElement.closest === 'function'
    ? asElement
    : (node as Node).parentElement;
  return Boolean(element?.closest(CHAT_INPUT_HOST_SELECTOR));
};

const readTextControlSelection = (element: Element): string | null => {
  if (isInsideChatComposer(element)) {
    return null;
  }

  const tag = element.tagName?.toLowerCase();
  if (tag === 'textarea') {
    const control = element as HTMLTextAreaElement;
    const start = control.selectionStart ?? 0;
    const end = control.selectionEnd ?? 0;
    const text = trimSelectionValue(control.value.slice(start, end));
    if (!text) {
      return null;
    }
    // Collapse so a duplicate menu delivery cannot append the same range twice.
    control.selectionStart = end;
    control.selectionEnd = end;
    return text;
  }

  if (tag === 'input') {
    const control = element as HTMLInputElement;
    const type = control.type?.toLowerCase() ?? 'text';
    if (!['text', 'search', 'url', 'tel', 'password'].includes(type)) {
      return null;
    }
    const start = control.selectionStart ?? 0;
    const end = control.selectionEnd ?? 0;
    const text = trimSelectionValue(control.value.slice(start, end));
    if (!text) {
      return null;
    }
    control.selectionStart = end;
    control.selectionEnd = end;
    return text;
  }

  return null;
};

const captureActiveElementSelection = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const activeElement = document.activeElement;
  if (!activeElement || typeof (activeElement as Element).tagName !== 'string') {
    return null;
  }

  const text = readTextControlSelection(activeElement as Element);
  return text ? wrapMarkdownSelectionForChat(text) : null;
};

const captureCodeMirrorSelection = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const focusedEditor = document.querySelector<HTMLElement>('.cm-editor.cm-focused');
  if (!focusedEditor || isInsideChatComposer(focusedEditor)) {
    return null;
  }

  const view = EditorView.findFromDOM(focusedEditor);
  if (!view) {
    return null;
  }

  const { from, to } = view.state.selection.main;
  if (from === to) {
    return null;
  }

  const text = trimSelectionValue(view.state.sliceDoc(from, to));
  if (!text) {
    return null;
  }

  view.dispatch({
    selection: { anchor: to },
  });

  return formatCodeSelectionMarkdown(text);
};

const captureDomSelection = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (isInsideChatComposer(range.commonAncestorContainer)) {
    return null;
  }

  const plainText = trimSelectionValue(selection.toString());
  if (!plainText) {
    return null;
  }

  const markdown = rangeToMarkdown(range, plainText);
  selection.removeAllRanges();
  return wrapMarkdownSelectionForChat(markdown);
};

/**
 * Capture the current non-composer selection as chat-ready markdown.
 * Returns null when nothing usable is selected.
 */
export const captureSelectionMarkdownForChat = (): string | null => {
  return captureCodeMirrorSelection()
    ?? captureActiveElementSelection()
    ?? captureDomSelection();
};

/**
 * Append the current selection to the chat composer.
 * When nothing is selected, focuses the chat input (Cursor-style Ctrl/Cmd+L).
 * Returns true when selected text was appended.
 */
export const addSelectionToChat = (): boolean => {
  const markdown = captureSelectionMarkdownForChat();

  useUIStore.getState().setSessionSwitcherOpen(false);

  if (markdown) {
    useInputStore.getState().setPendingInputText(markdown, 'append');
  }

  queueMicrotask(() => {
    focusChatInput();
  });

  return markdown !== null;
};
