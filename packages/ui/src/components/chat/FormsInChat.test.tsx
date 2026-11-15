import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

type FormRequest = import('@/lib/opencode/model').FormRequest;
type FormAnswer = import('@/sync/session-actions').FormAnswer;
type Call = { kind: 'reply' | 'cancel' | 'send'; sessionID: string; formID: string; answer?: FormAnswer };

let calls: Call[] = [];
let pendingForms: FormRequest[] = [];
// The memoized dock re-renders only when the store tells it the list changed.
const pendingListeners = new Set<() => void>();
const refreshPendingForms = (next: FormRequest[]) => {
  pendingForms = next;
  for (const listener of pendingListeners) listener();
};
const subscribePendingForms = (listener: () => void) => {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
};

const actualSessionActions = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  replyToForm: async (sessionID: string, formID: string, answer: FormAnswer) => { calls.push({ kind: 'reply', sessionID, formID, answer }); },
  cancelForm: async (sessionID: string, formID: string) => { calls.push({ kind: 'cancel', sessionID, formID }); },
  sendRecoveredFormAnswer: async (question: RecoveredQuestion) => { calls.push({ kind: 'send', sessionID: question.sessionID, formID: question.form.id }); },
}));
const recoverable = await import('@/sync/recoverable-questions');
type RecoveredQuestion = import('@/sync/recoverable-questions').RecoveredQuestion;
// The cards a question deferred on send leaves (#5391): the real recovery store decides them, so a
// local dismissal closes them the way it does in the app.
const deferredView = {
  form: {},
  part: { 'msg-ask': [{
    id: 'tool-ask', sessionID: 'session-1', messageID: 'msg-ask', callID: 'call-1', tool: 'question', type: 'tool' as const,
    state: { status: 'error' as const, input: {}, error: recoverable.DEFERRED_QUESTION_NOTE, errorType: 'tool.execution', time: { start: 1, end: 2 } },
  }] },
};
const useDeferredQuestions = () => {
  const recovery = recoverable.useRecoverableQuestionsStore();
  return React.useMemo(() => recoverable.deriveRecoveredQuestions(deferredView, recovery, new Set(['session-1'])), [recovery]);
};
const actualSync = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...actualSync,
  useScopedBlockingForms: () => React.useSyncExternalStore(subscribePendingForms, () => pendingForms),
  useRecoveredQuestions: useDeferredQuestions,
  useSessions: () => [],
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

const { FormDock } = await import('./FormDock');
const { FormCard } = await import('./FormCard');
const { TranscriptForms } = await import('./TranscriptForms');
const { resolveFormsInChat } = await import('./formsInChat');
const { I18nProvider } = await import('@/lib/i18n');
const { dict: en } = await import('@/lib/i18n/messages/en');
const { isWaitingPageRevealPending, pendingWaitingPageID, revealRequest, takeWaitingPageReveal } = await import('@/sync/request-reveal');
const { formDraftScope, loadFormDraft, resetFormDrafts } = await import('./formDrafts');
const { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
    Event: happyWindow.Event,
    CustomEvent: happyWindow.CustomEvent,
    ResizeObserver: happyWindow.ResizeObserver,
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

// One required choice and one optional text answer: the dock keeps Submit off
// until both have an answer, which the card in the chat must match.
const question = (id: string, title: string): FormRequest => ({
  id,
  sessionID: 'session-1',
  title,
  fields: [
    { key: 'color', type: 'string', title: 'Color', required: true, options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] },
    { key: 'note', type: 'string', title: 'Note' },
  ],
});

const buttons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('button')];
const button = (root: HTMLElement, text: string) => {
  const found = buttons(root).find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
const click = async (target: HTMLElement) => { await act(async () => target.click()); };
const type = async (root: HTMLElement, text: string) => {
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('Missing text box');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('questions in the chat', () => {
  let dom: ReturnType<typeof installDom>;
  let root: ReturnType<typeof createRoot>;
  const render = async (node: React.ReactNode) => {
    await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
  };

  beforeEach(() => {
    calls = [];
    pendingForms = [question('form-1', 'Pick a color')];
    resetFormDrafts();
    recoverable.resetRecoverableQuestions();
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    takeWaitingPageReveal('session-1');
    dom.restore();
  });

  test('with the setting off the dock is the full question, as before', async () => {
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
    expect(buttons(dom.container).some((item) => item.textContent?.trim() === en['chat.questionCard.dismiss'])).toBe(true);
    expect(buttons(dom.container).some((item) => item.textContent?.trim() === 'Red')).toBe(true);
    expect(dom.container.querySelector(`[aria-label="${en['chat.formDock.showInChatAria']}"]`)).toBeNull();
  });

  test('with the setting on the dock is one line that asks for that form\'s card', async () => {
    pendingForms = [question('form-1', 'Pick a color'), question('form-2', 'Pick another')];
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} inChat />);
    expect(buttons(dom.container).some((item) => item.textContent?.trim() === 'Red')).toBe(false);
    expect(buttons(dom.container).some((item) => item.textContent?.trim() === en['chat.formCard.submit'])).toBe(false);
    expect(dom.container.textContent?.includes('Pick a color')).toBe(true);
    expect(dom.container.textContent?.includes(en['chat.formDock.waiting'].replace('{count}', '1'))).toBe(true);

    const pointer = dom.container.querySelector<HTMLButtonElement>(`button[aria-label="${en['chat.formDock.showInChatAria']}"]`);
    if (!pointer) throw new Error('Missing pointer');
    await click(pointer);
    expect(isWaitingPageRevealPending('session-1')).toBe(true);
    expect(pendingWaitingPageID()).toBe('form-1');

    // "Open session" on the second question's toast names its own card.
    takeWaitingPageReveal('session-1');
    await act(async () => revealRequest('form-2'));
    expect(isWaitingPageRevealPending('session-1')).toBe(true);
    expect(pendingWaitingPageID()).toBe('form-2');
  });

  test('a hidden dock shows no pointer either', async () => {
    await render(<FormDock sessionId="session-1" directory="/project" hidden inChat />);
    expect(buttons(dom.container).length).toBe(0);
  });

  test('the chat end holds one waiting block per pending form, named by its id', async () => {
    pendingForms = [question('form-1', 'Pick a color'), question('form-2', 'Pick another')];
    const announced: string[] = [];
    dom.container.addEventListener('openchamber:page-waiting', (event) => {
      announced.push(event.target instanceof HTMLElement ? event.target.dataset.waitingPage ?? '' : '');
    });
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    const blocks = [...dom.container.querySelectorAll<HTMLElement>('[data-waiting-page]')].map((block) => block.dataset.waitingPage);
    expect(blocks).toEqual(['form-1', 'form-2']);
    expect(announced).toEqual(['form-1', 'form-2']);
    expect(dom.container.textContent?.includes('Pick another')).toBe(true);

    pendingForms = [];
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    expect(dom.container.querySelector('[data-waiting-page]')).toBeNull();
  });

  test('the card in the chat waits for every answer and sends the same reply as the dock', async () => {
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
    await click(button(dom.container, 'Red'));
    await click(button(dom.container, en['chat.questionCard.next']));
    await type(dom.container, 'bright');
    await click(button(dom.container, en['chat.formCard.submit']));
    const fromDock = calls;
    expect(fromDock.length).toBe(1);

    calls = [];
    resetFormDrafts();
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    const submit = () => button(dom.container, en['chat.formCard.submit']);
    expect(submit().disabled).toBe(true);
    await click(button(dom.container, 'Red'));
    // The optional note is still open, so Submit stays off, as in the dock.
    expect(submit().disabled).toBe(true);
    await type(dom.container, 'bright');
    expect(submit().disabled).toBe(false);
    await click(submit());
    expect(calls).toEqual(fromDock);
    expect(calls[0]).toEqual({ kind: 'reply', sessionID: 'session-1', formID: 'form-1', answer: { color: 'red', note: 'bright' } });
  });

  test('a half-filled card keeps its answer when it unmounts and comes back', async () => {
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    await click(button(dom.container, 'Red'));
    await render(null);
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    await type(dom.container, 'bright');
    await click(button(dom.container, en['chat.formCard.submit']));
    expect(calls[0]?.answer).toEqual({ color: 'red', note: 'bright' });
  });

  test('cancel on the card goes through the same cancel request as the dock', async () => {
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    await click(button(dom.container, en['chat.formCard.cancel']));
    expect(calls).toEqual([{ kind: 'cancel', sessionID: 'session-1', formID: 'form-1' }]);
  });

  test('the BTW sheet\'s card keeps its own rule: optional questions may stay open', async () => {
    await render(<FormCard form={question('form-1', 'Pick a color')} />);
    await click(button(dom.container, 'Red'));
    await click(button(dom.container, en['chat.formCard.submit']));
    expect(calls[0]?.answer).toEqual({ color: 'red' });
  });

  test('Enter in the card follows its button: nothing is sent while a question is open', async () => {
    const twoTexts = (): FormRequest => ({ id: 'form-kb', sessionID: 'session-1', title: 'Two answers', fields: [
      { key: 'first', type: 'string', title: 'Required', required: true },
      { key: 'second', type: 'string', title: 'Optional' },
    ] });
    const enter = async (textarea: HTMLTextAreaElement) => {
      await act(async () => textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    };
    const fill = async (textarea: HTMLTextAreaElement, text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    pendingForms = [twoTexts()];
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    const [first, second] = [...dom.container.querySelectorAll<HTMLTextAreaElement>('textarea')];
    if (!first || !second) throw new Error('Missing text boxes');
    await fill(first, 'answer one');
    await enter(first);
    expect(calls).toEqual([]);
    await fill(second, 'answer two');
    await enter(second);
    expect(calls).toEqual([{ kind: 'reply', sessionID: 'session-1', formID: 'form-kb', answer: { first: 'answer one', second: 'answer two' } }]);

    // The BTW sheet's card still sends on Enter with the optional one open.
    calls = [];
    await render(null);
    await render(<FormCard form={twoTexts()} />);
    const btwFirst = dom.container.querySelector<HTMLTextAreaElement>('textarea');
    if (!btwFirst) throw new Error('Missing text box');
    await fill(btwFirst, 'answer one');
    await enter(btwFirst);
    expect(calls).toEqual([{ kind: 'reply', sessionID: 'session-1', formID: 'form-kb', answer: { first: 'answer one' } }]);
  });

  test('a link step the dock had not reached is answerable after switching to the card', async () => {
    pendingForms = [{ id: 'form-ext', sessionID: 'session-1', title: 'External', fields: [
      { key: 'first', type: 'string', title: 'First', required: true },
      { key: 'ext', type: 'external', title: 'Link', url: 'https://example.invalid/' },
    ] }];
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
    await type(dom.container, 'answer');
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    const submit = button(dom.container, en['chat.formCard.submit']);
    expect(dom.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('answer');
    expect(submit.disabled).toBe(false);
    await click(submit);
    expect(calls).toEqual([{ kind: 'reply', sessionID: 'session-1', formID: 'form-ext', answer: { first: 'answer', ext: true } }]);
  });

  test('a directory\'s question shown in two retained sessions sends the latest choice', async () => {
    pendingForms = [{ ...question('form-global', 'Question for the directory'), sessionID: 'global' }];
    // Retained session timelines, as KeepAlive keeps them.
    const view = (shown: 'A' | 'B', withB: boolean) => <>
      <React.Activity key="A" mode={shown === 'A' ? 'visible' : 'hidden'}><div data-slot="A"><TranscriptForms sessionId="A" directory="/project" /></div></React.Activity>
      {withB ? <React.Activity key="B" mode={shown === 'B' ? 'visible' : 'hidden'}><div data-slot="B"><TranscriptForms sessionId="B" directory="/project" /></div></React.Activity> : null}
    </>;
    const slot = (name: string) => {
      const found = dom.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
      if (!found) throw new Error(`Missing slot ${name}`);
      return found;
    };
    await render(view('A', false));
    await click(button(slot('A'), 'Red'));
    await render(view('B', true));
    await click(button(slot('B'), 'Blue'));
    await render(view('A', true));
    await type(slot('A'), 'note');
    await click(button(slot('A'), en['chat.formCard.submit']));
    expect(calls).toEqual([{ kind: 'reply', sessionID: 'global', formID: 'form-global', answer: { color: 'blue', note: 'note' } }]);
  });

  // A snapshot refresh of the pending list (a reconnect or a directory
  // snapshot) hands every surface a new object of the same form; a dock must
  // not save what it holds over an answer typed elsewhere.
  const noteOnly = (): FormRequest => ({ id: 'form-note', sessionID: 'session-1', title: 'A note', fields: [
    { key: 'note', type: 'string', title: 'Note' },
  ] });
  const savedNote = () => loadFormDraft(formDraftScope({ id: 'form-note', sessionID: 'session-1' }, '/project'))?.values.note?.text;
  const slot = (name: string) => {
    const found = dom.container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
    if (!found) throw new Error(`Missing slot ${name}`);
    return found;
  };

  test('two docks on one form keep the typed answer when the pending list is refreshed', async () => {
    pendingForms = [noteOnly()];
    // A chat pinned in the side panel and the main chat, both with the full dock.
    const view = () => <>
      <div data-slot="main"><FormDock sessionId="session-1" directory="/project" hidden={false} /></div>
      <div data-slot="pinned"><FormDock sessionId="session-1" directory="/project" hidden={false} /></div>
    </>;
    await render(view());
    await type(slot('main'), 'my answer');
    expect(savedNote()).toBe('my answer');

    await act(async () => refreshPendingForms([noteOnly()]));
    expect(savedNote()).toBe('my answer');
  });

  test('a dock beside a card keeps the card\'s answer when the pending list is refreshed', async () => {
    pendingForms = [noteOnly()];
    // The transcript's card above, the full dock of an expanded composer below.
    const view = () => <>
      <div data-slot="card"><TranscriptForms sessionId="session-1" directory="/project" /></div>
      <div data-slot="dock"><FormDock sessionId="session-1" directory="/project" hidden={false} /></div>
    </>;
    await render(view());
    await type(slot('card'), 'card answer');
    expect(savedNote()).toBe('card answer');

    await act(async () => refreshPendingForms([noteOnly()]));
    expect(savedNote()).toBe('card answer');
  });

  // VS Code and the mini chat switch runtimes without remounting the chat, and
  // two runtimes can hold a form with the same id, session and directory.
  test('a runtime switch starts the dock over from that runtime\'s draft', async () => {
    const previousBaseUrl = getRuntimeApiBaseUrl();
    const previousKey = getRuntimeKey();
    const noteIn = (runtimeKey: string) => loadFormDraft(formDraftScope({ id: 'form-note', sessionID: 'session-1' }, '/project', runtimeKey))?.values.note?.text;
    // The panel of the runtime switched away from may still be fading out
    // above the new one.
    const textbox = () => [...dom.container.querySelectorAll<HTMLTextAreaElement>('textarea')].at(-1);
    const typeInShownPanel = async (text: string) => {
      const target = textbox();
      if (!target) throw new Error('Missing text box');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(target, text);
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      pendingForms = [noteOnly()];
      await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
      await type(dom.container, 'answer for a');
      expect(noteIn('runtime-a')).toBe('answer for a');

      await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' }));
      await act(async () => refreshPendingForms([noteOnly()]));
      expect(noteIn('runtime-b')).toBe('');
      expect(noteIn('runtime-a')).toBe('answer for a');

      expect(textbox()?.value).toBe('');
      await typeInShownPanel('answer for b');
      expect(noteIn('runtime-b')).toBe('answer for b');
      expect(noteIn('runtime-a')).toBe('answer for a');

      // Back on the first runtime, its own answer comes back.
      await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' }));
      await act(async () => {});
      const shown = [...dom.container.querySelectorAll<HTMLTextAreaElement>('textarea')].map((item) => item.value);
      expect(shown).toContain('answer for a');
      expect(noteIn('runtime-a')).toBe('answer for a');
      expect(noteIn('runtime-b')).toBe('answer for b');
    } finally {
      switchRuntimeEndpoint({ apiBaseUrl: previousBaseUrl, runtimeKey: previousKey });
    }
  });

  // A question deferred on send: dismissing its card closes it and its draft here, and sends nothing,
  // so the agent never gets an answer the user did not give.
  test('dismissing a deferred card in the dock or the chat closes it and sends nothing', async () => {
    const deferred = (): FormRequest => ({ ...noteOnly(), id: 'form-deferred', metadata: { kind: 'question', tool: { messageID: 'msg-ask', id: 'tool-ask' } } });
    const deferredNote = () => loadFormDraft(formDraftScope({ id: 'form-deferred', sessionID: 'session-1' }, '/project'))?.values.note;
    for (const [surface, view, dismiss] of [
      ['dock', <FormDock sessionId="session-1" directory="/project" hidden={false} />, en['chat.questionCard.dismiss']],
      ['chat', <TranscriptForms sessionId="session-1" directory="/project" />, en['chat.formCard.cancel']],
    ] as const) {
      recoverable.resetRecoverableQuestions();
      resetFormDrafts();
      calls = [];
      pendingForms = [];
      recoverable.noteQuestionFormSnapshot('/project', [deferred()]);
      await render(view);
      expect(dom.container.textContent?.includes(en['chat.formCard.deferredNotice'])).toBe(true);
      await type(dom.container, `${surface} draft`);
      expect(deferredNote()?.text).toBe(`${surface} draft`);

      await click(button(dom.container, dismiss));
      expect(calls).toEqual([]);
      expect(deferredNote()).toBeUndefined();
      expect(recoverable.useRecoverableQuestionsStore.getState().outcomes.get('form-deferred')).toBe('dismissed');
      // The dock's panel fades out through its exit animation, so the closed list is checked, not the DOM.
      expect([surface, recoverable.deriveRecoveredQuestions(deferredView, recoverable.useRecoverableQuestionsStore.getState(), new Set(['session-1']))]).toEqual([surface, []]);
      await render(null);
    }
  });

  test('a chat pinned in the side panel keeps the full dock', () => {
    expect(resolveFormsInChat({ questionsInChat: true, pinned: false, transcriptShown: true })).toBe(true);
    expect(resolveFormsInChat({ questionsInChat: true, pinned: true, transcriptShown: true })).toBe(false);
    expect(resolveFormsInChat({ questionsInChat: true, pinned: false, transcriptShown: false })).toBe(false);
    expect(resolveFormsInChat({ questionsInChat: false, pinned: false, transcriptShown: true })).toBe(false);
  });
});
