import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { ChatColumnSessionContext, ChatColumnTakesPromptsContext } from '../../chatColumnSession';
import { QuestionToolDetails } from './QuestionToolDetails';

// Answer sends through the composer of the chat showing the call's session.
// ChatContainer mounts no composer for a chat that takes no prompts (a
// read-only surface, a deleted space's archived chat, a subagent's session),
// so the row offers Answer only where its column says the chat takes them.
// Static renders, as in QuestionToolDetailsView.test.tsx.

const SESSION_ID = 'ses_question';

const call: ToolPart = {
  id: 'prt_question',
  sessionID: SESSION_ID,
  messageID: 'msg_question',
  type: 'tool',
  callID: 'call_question',
  tool: 'question',
  state: {
    status: 'error',
    input: {
      questions: [{
        header: 'Mode',
        question: 'Which mode should it use?',
        multiple: false,
        options: [{ label: 'Fast', description: 'One model call' }],
      }],
    },
    error: 'The user dismissed this question',
    time: { start: 1, end: 2 },
  },
};

const renderScrollBox = (questions: ReactNode) => <div>{questions}</div>;

const buttonsIn = (column: { sessionId: string; takesPrompts: boolean } | null) => {
  const row = <QuestionToolDetails part={call} state={call.state} renderScrollBox={renderScrollBox} />;
  const html = renderToStaticMarkup(
    <I18nProvider>
      {column ? (
        <ChatColumnSessionContext.Provider value={{ sessionId: column.sessionId, directory: '/repo' }}>
          <ChatColumnTakesPromptsContext.Provider value={column.takesPrompts}>{row}</ChatColumnTakesPromptsContext.Provider>
        </ChatColumnSessionContext.Provider>
      ) : row}
    </I18nProvider>,
  );
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim());
};

describe('QuestionToolDetails', () => {
  test('an ended call offers Answer in a chat that shows its session and takes prompts', () => {
    expect(buttonsIn({ sessionId: SESSION_ID, takesPrompts: true })).toContain('Answer');
  });

  test('a chat that takes no prompts offers no Answer, since no composer would send it', () => {
    expect(buttonsIn({ sessionId: SESSION_ID, takesPrompts: false })).not.toContain('Answer');
  });

  test('a chat showing another session, or no chat column at all, offers no Answer', () => {
    expect(buttonsIn({ sessionId: 'ses_other', takesPrompts: true })).not.toContain('Answer');
    expect(buttonsIn(null)).not.toContain('Answer');
  });
});
