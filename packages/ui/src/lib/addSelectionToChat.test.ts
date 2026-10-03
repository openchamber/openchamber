import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const focusChatInputCalls: number[] = [];
const pendingInputCalls: Array<{ text: string | null; mode?: string }> = [];
const sessionSwitcherCalls: boolean[] = [];
const codeMirrorDispatches: Array<{ selection: { anchor: number } }> = [];

type MockCodeMirrorView = {
  state: {
    selection: { main: { from: number; to: number } };
    sliceDoc: (from: number, to: number) => string;
  };
  dispatch: (transaction: { selection: { anchor: number } }) => void;
};

let codeMirrorView: MockCodeMirrorView | null = null;

mock.module('@codemirror/view', () => ({
  EditorView: {
    findFromDOM: () => codeMirrorView,
  },
}));

mock.module('@/components/chat/composer/editor/dom', () => ({
  focusChatInput: () => {
    focusChatInputCalls.push(1);
  },
}));

mock.module('@/sync/input-store', () => ({
  useInputStore: {
    getState: () => ({
      setPendingInputText: (text: string | null, mode?: string) => {
        pendingInputCalls.push({ text, mode });
      },
    }),
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setSessionSwitcherOpen: (open: boolean) => {
        sessionSwitcherCalls.push(open);
      },
    }),
  },
}));

const { addSelectionToChat, captureSelectionMarkdownForChat } = await import('./addSelectionToChat');

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

const installSelectionEnvironment = (options: {
  activeElement?: Element | null;
  focusedCodeMirror?: Element | null;
  selection?: Selection | null;
} = {}) => {
  const {
    activeElement = null,
    focusedCodeMirror = null,
    selection = null,
  } = options;

  const documentLike = {
    activeElement,
    querySelector: (selector: string) => {
      if (selector === '.cm-editor.cm-focused') {
        return focusedCodeMirror;
      }
      return null;
    },
  };
  const windowLike = {
    getSelection: () => selection,
  };
  Object.defineProperty(globalThis, 'document', { value: documentLike, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: windowLike, configurable: true });
};

const clearCalls = () => {
  focusChatInputCalls.length = 0;
  pendingInputCalls.length = 0;
  sessionSwitcherCalls.length = 0;
  codeMirrorDispatches.length = 0;
  codeMirrorView = null;
};

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
});

describe('captureSelectionMarkdownForChat', () => {
  beforeEach(() => {
    clearCalls();
  });

  test('returns null when nothing is selected', () => {
    installSelectionEnvironment();
    expect(captureSelectionMarkdownForChat()).toBeNull();
  });

  test('captures a textarea selection outside the composer and collapses it', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'alpha beta gamma',
      selectionStart: 6,
      selectionEnd: 10,
      closest: () => null,
    } as unknown as HTMLTextAreaElement;

    installSelectionEnvironment({ activeElement: textarea });
    expect(captureSelectionMarkdownForChat()).toBe('```md\nbeta\n```');
    expect(textarea.selectionStart).toBe(10);
    expect(textarea.selectionEnd).toBe(10);
  });

  test('ignores selections inside the chat composer', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'draft text',
      selectionStart: 0,
      selectionEnd: 5,
      closest: (selector: string) => (selector === '[data-chat-input="true"]' ? textarea : null),
    } as unknown as HTMLTextAreaElement;

    installSelectionEnvironment({ activeElement: textarea });
    expect(captureSelectionMarkdownForChat()).toBeNull();
  });

  test('captures a focused CodeMirror selection outside the composer and collapses it', () => {
    const focusedEditor = {
      closest: () => null,
    } as unknown as HTMLElement;

    codeMirrorView = {
      state: {
        selection: { main: { from: 4, to: 11 } },
        sliceDoc: (from: number, to: number) => 'const x'.slice(0, to - from),
      },
      dispatch: (transaction) => {
        codeMirrorDispatches.push(transaction);
        codeMirrorView!.state.selection.main = {
          from: transaction.selection.anchor,
          to: transaction.selection.anchor,
        };
      },
    };

    // sliceDoc should return the selected slice; use explicit text instead of slice math.
    codeMirrorView.state.sliceDoc = () => 'const x';

    installSelectionEnvironment({ focusedCodeMirror: focusedEditor });
    expect(captureSelectionMarkdownForChat()).toBe('```\nconst x\n```');
    expect(codeMirrorDispatches).toEqual([{ selection: { anchor: 11 } }]);
    expect(codeMirrorView.state.selection.main).toEqual({ from: 11, to: 11 });
  });

  test('ignores a focused CodeMirror editor inside the chat composer', () => {
    const focusedEditor = {
      closest: (selector: string) => (selector === '[data-chat-input="true"]' ? focusedEditor : null),
    } as unknown as HTMLElement;

    codeMirrorView = {
      state: {
        selection: { main: { from: 0, to: 5 } },
        sliceDoc: () => 'draft',
      },
      dispatch: (transaction) => {
        codeMirrorDispatches.push(transaction);
      },
    };

    installSelectionEnvironment({ focusedCodeMirror: focusedEditor });
    expect(captureSelectionMarkdownForChat()).toBeNull();
    expect(codeMirrorDispatches).toEqual([]);
  });

  test('captures a DOM selection from chat-message content and clears it', () => {
    const parent = {
      closest: (selector: string) => (selector === 'pre code' ? null : null),
    };
    const textNode = {
      nodeType: 3,
      parentElement: parent,
    };
    let rangeCount = 1;
    let collapsed = false;
    const selection = {
      get rangeCount() {
        return rangeCount;
      },
      get isCollapsed() {
        return collapsed;
      },
      toString: () => 'Hello world',
      getRangeAt: () => ({
        commonAncestorContainer: textNode,
        startContainer: textNode,
        endContainer: textNode,
        cloneContents: () => ({ childNodes: [] }),
      }),
      removeAllRanges: () => {
        rangeCount = 0;
        collapsed = true;
      },
    } as unknown as Selection;

    installSelectionEnvironment({ selection });
    expect(captureSelectionMarkdownForChat()).toBe('```md\nHello world\n```');
    expect(selection.rangeCount).toBe(0);
    expect(selection.isCollapsed).toBe(true);
  });

  test('ignores a DOM selection inside the chat composer', () => {
    const composerHost = {};
    const parent = {
      closest: (selector: string) => (selector === '[data-chat-input="true"]' ? composerHost : null),
    };
    const textNode = {
      nodeType: 3,
      parentElement: parent,
    };
    const selection = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => 'draft',
      getRangeAt: () => ({
        commonAncestorContainer: textNode,
        startContainer: textNode,
        endContainer: textNode,
        cloneContents: () => ({ childNodes: [] }),
      }),
      removeAllRanges: () => undefined,
    } as unknown as Selection;

    installSelectionEnvironment({ selection });
    expect(captureSelectionMarkdownForChat()).toBeNull();
  });
});

describe('addSelectionToChat', () => {
  beforeEach(() => {
    clearCalls();
  });

  test('appends captured selection and focuses chat input', async () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'selected',
      selectionStart: 0,
      selectionEnd: 8,
      closest: () => null,
    } as unknown as HTMLTextAreaElement;
    installSelectionEnvironment({ activeElement: textarea });

    expect(addSelectionToChat()).toBe(true);
    expect(sessionSwitcherCalls).toEqual([false]);
    expect(pendingInputCalls).toEqual([{ text: '```md\nselected\n```', mode: 'append' }]);

    await Promise.resolve();
    expect(focusChatInputCalls.length).toBe(1);
  });

  test('second capture after textarea collapse does not append again', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      value: 'selected',
      selectionStart: 0,
      selectionEnd: 8,
      closest: () => null,
    } as unknown as HTMLTextAreaElement;
    installSelectionEnvironment({ activeElement: textarea });

    expect(addSelectionToChat()).toBe(true);
    expect(addSelectionToChat()).toBe(false);
    expect(pendingInputCalls).toEqual([{ text: '```md\nselected\n```', mode: 'append' }]);
  });

  test('focuses chat input when nothing is selected', async () => {
    installSelectionEnvironment();

    expect(addSelectionToChat()).toBe(false);
    expect(pendingInputCalls).toEqual([]);

    await Promise.resolve();
    expect(focusChatInputCalls.length).toBe(1);
  });
});
