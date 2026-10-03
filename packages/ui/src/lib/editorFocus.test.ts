import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { isEditorEventTarget, isVimEditorEventTarget } from './editorFocus';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, Element: dom.Element });

const mountEditor = ({ vim }: { vim: boolean }) => {
  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  const content = document.createElement('div');
  content.className = 'cm-content';
  editor.appendChild(content);
  if (vim) {
    const panel = document.createElement('div');
    panel.className = 'cm-vim-panel';
    editor.appendChild(panel);
  }
  document.body.appendChild(editor);
  return { editor, content };
};

describe('isVimEditorEventTarget', () => {
  test('recognizes a key event from inside a Vim-keymap editor', () => {
    const { editor, content } = mountEditor({ vim: true });
    try {
      expect(isVimEditorEventTarget(content)).toBe(true);
    } finally {
      editor.remove();
    }
  });

  test('ignores editors on the default keymap, detached editors, and non-editor targets', () => {
    const plain = mountEditor({ vim: false });
    const detached = mountEditor({ vim: true });
    detached.editor.remove();
    const button = document.createElement('button');
    document.body.appendChild(button);
    try {
      expect(isVimEditorEventTarget(plain.content)).toBe(false);
      expect(isVimEditorEventTarget(detached.content)).toBe(false);
      expect(isVimEditorEventTarget(button)).toBe(false);
      expect(isVimEditorEventTarget(null)).toBe(false);
    } finally {
      plain.editor.remove();
      button.remove();
    }
  });
});

describe('isEditorEventTarget', () => {
  test('recognizes any CodeMirror editor and an overlay the editor opened, nothing else', () => {
    const { editor, content } = mountEditor({ vim: false });
    const overlay = document.createElement('div');
    overlay.setAttribute('data-editor-overlay', '');
    const input = document.createElement('input');
    overlay.appendChild(input);
    const outside = document.createElement('button');
    document.body.append(overlay, outside);
    try {
      expect(isEditorEventTarget(content)).toBe(true);
      expect(isEditorEventTarget(input)).toBe(true);
      expect(isEditorEventTarget(outside)).toBe(false);
      expect(isEditorEventTarget(null)).toBe(false);
    } finally {
      editor.remove();
      overlay.remove();
      outside.remove();
    }
  });
});
