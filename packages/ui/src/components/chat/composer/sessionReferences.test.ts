import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/opencode/model';
import { sessionMentionChip } from '@/lib/messages/sessionMentionChip';
import { messageText, sessionMessageReference, sessionReference, sessionReferenceKey, sessionReferencesInText } from './sessionReferences';

// SAFETY: message parts as the client projects them; these helpers read type, text and metadata.
const text = (value: string): Part => ({ id: 'prt', sessionID: 'ses_a', messageID: 'msg_a', type: 'text', text: value } as Part);
// SAFETY: a context part the app attached, as the server echoes it.
const context = { id: 'prt_c', sessionID: 'ses_a', messageID: 'msg_a', type: 'text', text: 'ctx', metadata: { openchamberContext: {} } } as Part;
// SAFETY: a tool part; only its type is read.
const tool = { id: 'prt_t', sessionID: 'ses_a', messageID: 'msg_a', type: 'tool' } as Part;

describe('session references', () => {
  test('a mentioned session names itself and how to read it, with no request attached', () => {
    const reference = sessionReference({ id: 'ses_a', title: 'Tweet writing' });
    expect(reference.contextText).toBe('The user referenced another OpenChamber session, "Tweet writing" (ses_a). Its messages can be read with the openchamber tool (session.messages, sessionId ses_a).');
    expect(sessionMentionChip(reference)).toEqual({ label: 'Tweet writing', title: 'Tweet writing', icon: 'chat-3' });
  });

  test('a message goes whole: its own text, never attached context or tool output, and no cut', () => {
    const long = 'x'.repeat(30_000);
    expect(messageText([text(' First '), tool, context, text(long)])).toBe(`First\n\n${long}`);
    const reference = sessionMessageReference({ id: 'ses_a', title: 'Tweet writing' }, { info: { id: 'msg_a', role: 'assistant' }, parts: [text(`Line one\nline two ${long}`)] });
    if (reference?.kind !== 'session-message') throw new Error('expected a message reference');
    expect(reference.contextText.startsWith('The user attached a message from another OpenChamber session, "Tweet writing" (ses_a, message msg_a). It was written by the agent of that session. The message:\n\nLine one\nline two')).toBe(true);
    expect(reference.contextText.endsWith(long)).toBe(true);
    // The chip shows the start of the message, on one line.
    expect(sessionMentionChip(reference).label).toBe(`Line one line two ${'x'.repeat(29)}…`);
    expect(sessionMessageReference({ id: 'ses_a', title: 't' }, { info: { id: 'msg_a', role: 'user' }, parts: [tool] })).toBeNull();
  });

  test('the text decides what goes: each mention once, in order, and what is not resolved yet', () => {
    const resolved = new Map([['ses_a:', sessionReference({ id: 'ses_a', title: 'A' })]]);
    const found = sessionReferencesInText(
      'openchamber://session/ses_b?message=msg_1 then openchamber://session/ses_a, again openchamber://session/ses_a.',
      [],
      resolved,
    );
    expect(found.references.map((reference) => reference.sessionId)).toEqual(['ses_a']);
    expect(found.unresolved).toEqual([{ sessionId: 'ses_b', messageId: 'msg_1' }]);
  });

  test('a message link whose message had no text keeps its own key, so it still finds its chip', () => {
    const fallback = { ...sessionReference({ id: 'ses_a', title: 'A' }), messageId: 'msg_1' };
    expect(sessionReferenceKey(fallback)).toBe('ses_a:msg_1');
    const found = sessionReferencesInText('openchamber://session/ses_a?message=msg_1', [], new Map([[sessionReferenceKey(fallback), fallback]]));
    expect(found.references).toEqual([fallback]);
  });
});
