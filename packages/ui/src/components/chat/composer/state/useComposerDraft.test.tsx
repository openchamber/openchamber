import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * A new-session draft that becomes its session keeps what was typed while the
 * session was being created; another draft open at that moment keeps its own
 * text instead of handing it to that session.
 */

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement,
  Event: browser.Event,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useComposerDraft } = await import('./useComposerDraft');
const { createChatDraftIdentity, readChatDraft } = await import('@/lib/chatDraftPersistence');

afterAll(() => {
  browser.close();
});

type HarnessProps = {
  identity: ReturnType<typeof createChatDraftIdentity>;
  newSessionDraftId: number | null;
  materializedDraft: { sessionId: string; draftId: number } | null;
  onText: (text: string) => void;
  typed: { current: ((text: string) => void) | null };
};

const Harness = ({ identity, newSessionDraftId, materializedDraft, onText, typed }: HarnessProps) => {
  const [message, setMessage] = React.useState('');
  const messageRef = React.useRef('');
  const confirmedMentionsRef = React.useRef(new Set<string>());
  messageRef.current = message;
  typed.current = (text) => {
    messageRef.current = text;
    setMessage(text);
  };
  useComposerDraft({
    message,
    messageRef,
    setMessage,
    confirmedMentionsRef,
    identity,
    initialDraft: { text: '', identity },
    newSessionDraftId,
    materializedDraft,
  });
  onText(message);
  return null;
};

/** Types into a draft, then turns the composer to a session created from draft 1. */
const typeThenOpenSession = async (draftId: number, text: string) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const draftIdentity = createChatDraftIdentity('runtime', `/repo/${draftId}`, null);
  const sessionId = `ses_${draftId}`;
  const sessionIdentity = createChatDraftIdentity('runtime', '/repo/1', sessionId);
  const typed: HarnessProps['typed'] = { current: null };
  let shown = '';
  const render = (props: Omit<HarnessProps, 'onText' | 'typed'>) => root.render(
    <Harness {...props} typed={typed} onText={(value) => { shown = value; }} />,
  );
  try {
    await act(async () => render({ identity: draftIdentity, newSessionDraftId: draftId, materializedDraft: null }));
    await act(async () => typed.current?.(text));
    await act(async () => render({
      identity: sessionIdentity,
      newSessionDraftId: null,
      materializedDraft: { sessionId, draftId: 1 },
    }));
    return { shown, draftLeft: draftIdentity ? readChatDraft(draftIdentity).text : null };
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

test('text typed in the draft while its session was created stays in the composer', async () => {
  const { shown } = await typeThenOpenSession(1, 'typed meanwhile');

  expect(shown).toBe('typed meanwhile');
});

test('another draft open at that moment keeps its own text', async () => {
  const { shown, draftLeft } = await typeThenOpenSession(2, 'for the other draft');

  expect(shown).toBe('');
  expect(draftLeft).toBe('for the other draft');
});
