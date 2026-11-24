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
// When set, the recovery view the chat derives its recovered questions from; `closeOnSend` makes a send record its outcome.
let recoveredView: import('@/sync/recoverable-questions').RecoverableQuestionStoreView | null = null;
let closeOnSend = false;
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
  sendRecoveredFormAnswer: async (question: RecoveredQuestion) => {
    calls.push({ kind: 'send', sessionID: question.sessionID, formID: question.form.id });
    if (closeOnSend) {
      await Promise.resolve();
      recoverable.noteLocalFormReplied(question.sessionID, question.form.id);
    }
  },
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
  return React.useMemo(() => recoverable.deriveRecoveredQuestions(recoveredView ?? deferredView, recovery, new Set(['session-1', 'session-child'])), [recovery]);
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
const { FormDockModeContext, resolveFormsInChat } = await import('./formsInChat');
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
    recoveredView = null;
    closeOnSend = false;
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
    await render(<FormDockModeContext.Provider value="in-chat"><FormDock sessionId="session-1" directory="/project" hidden={false} /></FormDockModeContext.Provider>);
    expect(buttons(dom.container).some((item) => item.textContent?.trim() === 'Red')).toBe(false);
    expect(buttons(dom.container).some((item) => item.textContent?.trim() === en['chat.formCard.submit'])).toBe(false);
    expect(dom.container.textContent?.includes('Pick a color')).toBe(true);
    expect(dom.container.textContent?.includes(en['chat.formDock.waiting'].replace('{count}', '1'))).toBe(true);

    const pointer = dom.container.querySelector<HTMLButtonElement>(`button[aria-label="${en['chat.formDock.showInChatAria']}"]`);
    if (!pointer) throw new Error('Missing pointer');
    await click(pointer);
    expect(isWaitingPageRevealPending('session-1')).toBe(true);
    expect(pendingWaitingPageID()).toBe('session-1/form-1');

    // "Open session" on the second question's toast names its own card.
    takeWaitingPageReveal('session-1');
    await act(async () => revealRequest('form-2'));
    expect(isWaitingPageRevealPending('session-1')).toBe(true);
    expect(pendingWaitingPageID()).toBe('session-1/form-2');
  });

  test('a hidden dock shows no pointer either', async () => {
    await render(<FormDockModeContext.Provider value="in-chat"><FormDock sessionId="session-1" directory="/project" hidden /></FormDockModeContext.Provider>);
    expect(buttons(dom.container).length).toBe(0);
  });

  test('the chat end holds one waiting block per pending form, named by its session and id', async () => {
    pendingForms = [question('form-1', 'Pick a color'), question('form-2', 'Pick another')];
    const announced: string[] = [];
    dom.container.addEventListener('openchamber:page-waiting', (event) => {
      announced.push(event.target instanceof HTMLElement ? event.target.dataset.waitingPage ?? '' : '');
    });
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    const blocks = [...dom.container.querySelectorAll<HTMLElement>('[data-waiting-page]')].map((block) => block.dataset.waitingPage);
    expect(blocks).toEqual(['session-1/form-1', 'session-1/form-2']);
    expect(announced).toEqual(['session-1/form-1', 'session-1/form-2']);
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

  // OpenCode accepts a caller-chosen form id in every session and directory, so two
  // sessions can hold a form with the same id. The dock is one component for all
  // sessions: the second form must not inherit the first one's answers and step.
  test('a form with the same id in another session or directory starts empty and replies with its own answers', async () => {
    const releaseNotes = (sessionID: string): FormRequest => ({ id: 'form-same', sessionID, title: 'Release notes', fields: [
      { key: 'codename', type: 'string', title: 'Codename' },
      { key: 'owner', type: 'string', title: 'Owner' },
    ] });
    const progress = (en['chat.formDock.progress']).replace('{current}', '1').replace('{total}', '2');
    // The panel of the form switched away from may still be fading out above the shown one.
    const shownDock = () => {
      const panel = [...dom.container.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
      if (!panel) throw new Error('Missing dock');
      return panel;
    };
    for (const [first, second] of [
      [{ sessionID: 'session-1', directory: '/project-a' }, { sessionID: 'session-2', directory: '/project-b' }],
      [{ sessionID: 'session-1', directory: '/project-a' }, { sessionID: 'session-2', directory: '/project-a' }],
      [{ sessionID: 'session-1', directory: '/project-a' }, { sessionID: 'session-1', directory: '/project-b' }],
    ] as const) {
      const label = `${first.sessionID}@${first.directory} then ${second.sessionID}@${second.directory}`;
      calls = [];
      resetFormDrafts();
      await render(null);
      pendingForms = [releaseNotes(first.sessionID)];
      await render(<FormDock sessionId={first.sessionID} directory={first.directory} hidden={false} />);
      await type(shownDock(), 'Aurora');
      await click(button(shownDock(), en['chat.questionCard.next']));
      await type(shownDock(), 'Ada');
      expect([label, shownDock().textContent?.includes(en['chat.formCard.submit'])]).toEqual([label, true]);

      await act(async () => refreshPendingForms([releaseNotes(second.sessionID)]));
      await render(<FormDock sessionId={second.sessionID} directory={second.directory} hidden={false} />);
      expect([label, shownDock().querySelector('textarea')?.value]).toEqual([label, '']);
      expect([label, shownDock().textContent?.includes(progress)]).toEqual([label, true]);

      await type(shownDock(), 'Borealis');
      await click(button(shownDock(), en['chat.questionCard.next']));
      await type(shownDock(), 'Bob');
      await click(button(shownDock(), en['chat.formCard.submit']));
      expect([label, calls]).toEqual([label, [{ kind: 'reply', sessionID: second.sessionID, formID: 'form-same', answer: { codename: 'Borealis', owner: 'Bob' } }]]);
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
      expect(recoverable.useRecoverableQuestionsStore.getState().outcomes.get('session-1\u0000form-deferred')).toBe('dismissed');
      // The dock's panel fades out through its exit animation, so the closed list is checked, not the DOM.
      expect([surface, recoverable.deriveRecoveredQuestions(deferredView, recoverable.useRecoverableQuestionsStore.getState(), new Set(['session-1']))]).toEqual([surface, []]);
      await render(null);
    }
  });

  // A parent and its child can each hold a recovered question with one id (the server lets a caller reuse an id
  // once the first form has expired). Answering the first must leave the second card, with its own answer.
  test('two recovered questions with one id keep the second card after the first is answered', async () => {
    const asked = (sessionID: string): FormRequest => ({
      id: 'form-same', sessionID, title: `Question from ${sessionID}`, fields: [{ key: 'note', type: 'string', title: 'Note' }],
      metadata: { kind: 'question', tool: { messageID: `msg-${sessionID}`, id: `tool-${sessionID}` } },
    });
    const interrupted = (sessionID: string) => ({
      id: `tool-${sessionID}`, sessionID, messageID: `msg-${sessionID}`, callID: 'call', tool: 'question', type: 'tool' as const,
      state: { status: 'error' as const, input: {}, error: 'Tool execution interrupted', errorType: 'aborted', time: { start: 1, end: 2 } },
    });
    closeOnSend = true;
    pendingForms = [];
    recoveredView = { form: {}, part: { 'msg-session-1': [interrupted('session-1')], 'msg-session-child': [interrupted('session-child')] } };
    recoverable.noteQuestionFormSnapshot('/project', [asked('session-1')]);
    recoverable.noteQuestionFormSnapshot('/project', [asked('session-child')]);
    // The timeline remembers which waiting blocks it brought into view by name, so the two cards need two names.
    const announced: string[] = [];
    dom.container.addEventListener('openchamber:page-waiting', (event) => {
      announced.push(event.target instanceof HTMLElement ? event.target.dataset.waitingPage ?? '' : '');
    });
    await render(<TranscriptForms sessionId="session-1" directory="/project" />);
    const cards = () => [...dom.container.querySelectorAll<HTMLElement>('[data-waiting-page]')];
    expect(cards().map((card) => card.dataset.waitingPage)).toEqual(['session-1/form-same', 'session-child/form-same']);
    expect(announced).toEqual(['session-1/form-same', 'session-child/form-same']);
    await type(cards()[0]!, 'first answer');
    await type(cards()[1]!, 'second answer');
    await click(button(cards()[0]!, en['chat.formCard.submit']));
    expect(calls).toEqual([{ kind: 'send', sessionID: 'session-1', formID: 'form-same' }]);
    expect(cards().length).toBe(1);
    expect(cards()[0]?.textContent?.includes('Question from session-child')).toBe(true);
    expect(cards()[0]?.querySelector('textarea')?.value).toBe('second answer');
  });

  // The card has no steps. A form on screen in the dock keeps its step when a card of the same form saves its answers.
  test('a card saving the answers of a form the dock shows keeps the dock\'s step', async () => {
    const form = { ...question('form-global', 'A directory question'), sessionID: 'global' };
    pendingForms = [form];
    const scope = formDraftScope(form, '/project');
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
    await click(button(dom.container, 'Red'));
    await click(button(dom.container, en['chat.questionCard.next']));
    await type(dom.container, 'second answer');
    expect(loadFormDraft(scope)?.step).toBe(1);
    await render(<FormCard form={form} keepDraft directory="/project" />);
    expect(loadFormDraft(scope)?.step).toBe(1);
    expect(loadFormDraft(scope)?.values.note?.text).toBe('second answer');
  });

  // The step of a stored dock draft means nothing for a form id reused with other fields.
  test('a card for a reused form id with other fields does not take the stored dock step', async () => {
    pendingForms = [question('form-reuse', 'Old question')];
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
    await click(button(dom.container, 'Red'));
    await click(button(dom.container, en['chat.questionCard.next']));
    await render(null);
    const newForm: FormRequest = { ...question('form-reuse', 'New question'), fields: [
      { key: 'newfirst', type: 'string', title: 'New first' },
      { key: 'newsecond', type: 'string', title: 'New second' },
    ] };
    pendingForms = [newForm];
    await render(<FormCard form={newForm} keepDraft directory="/project" />);
    expect(loadFormDraft(formDraftScope(newForm, '/project'))?.step).toBe(0);
    await render(null);
    await render(<FormDock sessionId="session-1" directory="/project" hidden={false} />);
    expect(dom.container.textContent).toContain('1 of 2');
  });

  test('a chat pinned in the side panel keeps the full dock', () => {
    expect(resolveFormsInChat({ questionsInChat: true, pinned: false, transcriptShown: true })).toBe(true);
    expect(resolveFormsInChat({ questionsInChat: true, pinned: true, transcriptShown: true })).toBe(false);
    expect(resolveFormsInChat({ questionsInChat: true, pinned: false, transcriptShown: false })).toBe(false);
    expect(resolveFormsInChat({ questionsInChat: false, pinned: false, transcriptShown: true })).toBe(false);
  });

  describe('the dock while the reader scrolls up', () => {
    const renderDock = (mode: 'dock' | 'reading') => render(
      <FormDockModeContext.Provider value={mode}><FormDock sessionId="session-1" directory="/project" hidden={false} /></FormDockModeContext.Provider>,
    );
    const header = () => {
      const found = dom.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
      if (!found) throw new Error('Missing dock header');
      return found;
    };
    const showsOptions = () => buttons(dom.container).some((item) => item.textContent?.trim() === 'Red');

    test('the dock shrinks to its header while the reader is away from the end and opens again at the end', async () => {
      await renderDock('dock');
      expect(showsOptions()).toBe(true);
      await renderDock('reading');
      expect([header().getAttribute('aria-expanded'), showsOptions()]).toEqual(['false', false]);
      await renderDock('dock');
      expect([header().getAttribute('aria-expanded'), showsOptions()]).toEqual(['true', true]);
    });

    test('a dock whose text field has focus stays open while the reader scrolls up', async () => {
      await renderDock('dock');
      await click(button(dom.container, 'Red'));
      await click(button(dom.container, en['chat.questionCard.next']));
      const textarea = dom.container.querySelector<HTMLTextAreaElement>('textarea');
      if (!textarea) throw new Error('Missing text box');
      await act(async () => textarea.focus());
      await renderDock('reading');
      expect(dom.container.querySelector('textarea')).toBe(textarea);
      expect(document.activeElement).toBe(textarea);
    });

    test('a dock collapsed at the end stays collapsed after the reader comes back', async () => {
      await renderDock('dock');
      await click(header());
      await renderDock('reading');
      await renderDock('dock');
      expect([header().getAttribute('aria-expanded'), showsOptions()]).toEqual(['false', false]);
    });

    test('a dock opened while reading stays open, and one collapsed again while reading opens at the end', async () => {
      await renderDock('dock');
      await renderDock('reading');
      await click(header());
      expect(showsOptions()).toBe(true);
      await click(header());
      expect(showsOptions()).toBe(false);
      await renderDock('dock');
      expect(showsOptions()).toBe(true);
    });
  });
});
