import { z } from 'zod';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { createOpenUIAnswers } from './answers.js';
import { inspectOpenUI } from './program.js';
import { readOpenUIInstructionGroups } from './context/assets.js';

const disabled = () => new OpenChamberControlError('OpenUI is turned off in OpenChamber settings', 403);

/** Validates programs before entering the existing page-answer lifecycle. */
export const createOpenUIRuntime = ({ isEnabled, onWaitChange, getClient, resolveSessionDirectory }) => {
  const answers = createOpenUIAnswers({ onWaitChange });
  let cancellation = 0;
  const requireEnabled = async () => {
    if (!await isEnabled()) throw disabled();
  };

  const prompt = async (input, { sessionId, callId, directory, signal } = {}) => {
    const admittedBefore = cancellation;
    await requireEnabled();
    if (admittedBefore !== cancellation) throw disabled();
    const parsed = z.string().safeParse(input.ui);
    if (!parsed.success || !parsed.data.trim()) throw new OpenChamberControlError('ui is required: send one complete OpenUI program', 400);
    const ui = parsed.data;
    if (ui.length > 200_000) throw new OpenChamberControlError(`ui is ${ui.length} characters; the limit is 200000`, 400);
    if (Buffer.byteLength(JSON.stringify({ input: { action: 'openui.prompt', ui } }), 'utf8') >= 1_000_000) {
      throw new OpenChamberControlError('ui is too large after JSON encoding; make the program smaller', 413);
    }
    if (!sessionId || !callId) throw new OpenChamberControlError('This connection cannot wait for an OpenUI answer', 400);
    const inspected = inspectOpenUI(ui);
    if (!inspected.valid) {
      const details = inspected.diagnostics.map((error) => {
        const location = [error.component, error.path, error.statementId].filter(Boolean).join(' ');
        return location ? `${location}: ${error.message}` : error.message;
      }).join('\n');
      throw new OpenChamberControlError(details || 'ui must be a complete valid OpenUI program', 400);
    }
    if (!directory && resolveSessionDirectory) directory = await resolveSessionDirectory(sessionId);
    if (admittedBefore !== cancellation) throw disabled();
    let hasEarlierChat = false;
    try {
      const client = await getClient();
      const items = await client.session.inbox.list({ sessionID: sessionId });
      hasEarlierChat = items.some((item) => item.type === 'user' && item.delivery === 'steer');
    } catch (error) {
      console.warn('[openui] could not read the session inbox:', error?.message ?? error);
    }
    if (admittedBefore !== cancellation) throw disabled();
    if (signal?.aborted) throw new OpenChamberControlError('The page stopped waiting before the user answered', 499);
    if (hasEarlierChat) return {
      answer: { answered: false, reason: 'chat-sent-earlier' },
      note: 'The page did not wait: the user had already written in the chat before it appeared, and that message follows this result. They wrote it without seeing the page, so it is not an answer to it. Continue from that message; show the page again only if it still fits.',
    };
    const answer = await answers.wait({ sessionId, callId, directory, signal });
    return { answer };
  };

  return {
    prompt,
    answer: answers.answer,
    read: async (groups) => { await requireEnabled(); return readOpenUIInstructionGroups(groups); },
    cancel: () => { cancellation++; answers.cancel(disabled()); },
  };
};
