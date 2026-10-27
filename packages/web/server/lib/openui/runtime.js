import { createHash } from 'node:crypto';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { createOpenUIAnswers } from './answers.js';
import { inspectOpenUI } from './program.js';
import { readOpenUIInstructionGroups } from './context/assets.js';

const sourceRevision = (source) => createHash('sha256').update(source, 'utf8').digest('hex');
const disabled = () => new OpenChamberControlError('OpenUI is turned off in OpenChamber settings', 403);

/** Owns OpenUI policy; transports and shared waits do not interpret tool records. */
export const createOpenUIRuntime = ({ isEnabled, onWaitChange, getClient, resolveSessionDirectory }) => {
  const answers = createOpenUIAnswers({ onWaitChange });
  let cancellation = 0;
  const requireEnabled = async () => {
    if (!await isEnabled()) throw disabled();
  };
  const readSource = async ({ sessionId, callId, directory, signal }) => {
    if (!directory) throw new OpenChamberControlError('OpenUI source is unavailable', 503);
    const client = await getClient(directory);
    const seen = new Set();
    let cursor;
    for (;;) {
      signal?.throwIfAborted();
      const response = await client.message.list({
        sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: 'desc' }),
      }, { signal });
      if (!Array.isArray(response?.data)) throw new OpenChamberControlError('OpenUI source is unavailable', 503);
      for (const message of response.data) {
        if (message.type !== 'assistant') continue;
        const part = message.content.find((item) => item.type === 'tool' && item.id === callId);
        if (part) return part;
      }
      const next = response.cursor?.next;
      if (!next || response.data.length === 0) return null;
      if (seen.has(next)) throw new OpenChamberControlError('OpenUI source is unavailable', 503);
      seen.add(next);
      cursor = next;
    }
  };

  const prompt = async (input, { sessionId, callId, directory, signal } = {}) => {
    const admittedBefore = cancellation;
    await requireEnabled();
    if (admittedBefore !== cancellation) throw disabled();
    const ui = typeof input.ui === 'string' ? input.ui : '';
    if (!ui.trim()) throw new OpenChamberControlError('ui is required: send one complete OpenUI program', 400);
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
    const revision = sourceRevision(ui);
    if (!directory && resolveSessionDirectory) directory = await resolveSessionDirectory(sessionId);
    if (admittedBefore !== cancellation) throw disabled();
    const verifySource = async (retire) => {
      try {
        await requireEnabled();
        const part = await readSource({ sessionId, callId, directory, signal });
        if (!part || part.name !== 'prompt_openui' || part.state?.input?.ui !== ui) {
          throw new OpenChamberControlError('This OpenUI source has changed', 409);
        }
        await requireEnabled();
      } catch (error) {
        const failure = error instanceof OpenChamberControlError
          ? error : new OpenChamberControlError('OpenUI source is unavailable', 503);
        if (failure.statusCode === 403 || failure.statusCode === 409) retire(failure);
        throw failure;
      }
    };
    const answer = await answers.wait({
      sessionId, callId, directory, signal, sourceRevision: revision,
      validate: (input, retire) => {
        const received = asNonEmptyString(input.sourceRevision);
        if (!received) throw new OpenChamberControlError('sourceRevision is required for an OpenUI answer', 400);
        if (received !== revision) throw new OpenChamberControlError('This OpenUI source has changed', 409);
        return verifySource(retire);
      },
    });
    return { answer, sourceRevision: revision };
  };

  return {
    prompt,
    answer: answers.answer,
    read: async (groups) => { await requireEnabled(); return readOpenUIInstructionGroups(groups); },
    cancel: () => { cancellation++; answers.cancel(disabled()); },
  };
};
