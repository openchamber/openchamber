import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { isolatedBotToolPageSchema, isolatedBotToolReceiptSchema } from './isolated-tools.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { BotServiceError } from './services/contracts.js';

const refuse = (code) => { throw new BotServiceError(code, 'The recorded Bot tool call needs owner attention.'); };

/** The owner initiates every pull. Session metadata supplies a wake hint only. */
export function createBotHostTools({ dataDir, execution, handleTool, readToolOutcome }) {
  const receipts = createBotAdapterState({ dataDir, name: 'host-tool-receipts', schema: isolatedBotToolReceiptSchema });
  const forward = async (entry) => {
    if (entry.isolated || entry.stage !== 'fixing') refuse('BOT_FIXING_SESSION_REQUIRED');
    const session = await execution.readSession(entry);
    const marker = session.metadata?.openchamber?.automation;
    if (session.id !== entry.sessionId || session.directory !== entry.directory || session.archived
      || marker?.source !== 'bot' || marker.projectId !== entry.projectId || marker.botId !== entry.botId
      || marker.itemId !== entry.itemId || marker.stage !== 'fixing') refuse('BOT_FIXING_SESSION_REQUIRED');
    const page = isolatedBotToolPageSchema.parse(await execution.pullTools(entry));
    if (page.requests.some(({ id, request }) => request.sessionId !== entry.sessionId
      || id !== digestMutationInput({ sessionId: request.sessionId, callId: request.callId }))) refuse('BOT_HOST_TOOL_CHANGED');
    let forwarded = 0;
    for (const pending of page.requests) {
      const key = { projectId: entry.projectId, itemId: entry.itemId, sessionId: entry.sessionId, id: pending.id };
      await receipts.own(key, async () => {
        let receipt = await receipts.read(key);
        if (receipt && digestMutationInput(receipt.request) !== digestMutationInput(pending.request)) refuse('BOT_HOST_TOOL_CHANGED');
        // An interrupted owner call may have admitted a mutation. Resume owns its
        // original effect; pulling an inbox never grants a second execution.
        if (receipt?.state === 'dispatching') {
          const recovered = await readToolOutcome?.(receipt.request);
          if (recovered?.state !== 'succeeded') refuse('BOT_HOST_TOOL_OUTCOME_UNKNOWN');
          receipt = await receipts.write(key, { ...pending, state: 'settled', reply: { ok: true, result: recovered.result } });
        }
        if (!receipt) {
          await receipts.write(key, { ...pending, state: 'dispatching' });
          let reply;
          try { reply = { ok: true, result: z.json().parse(await handleTool({ sessionId: entry.sessionId,
            action: pending.request.action, input: pending.request.input })) }; }
          catch (error) {
            const code = /^BOT_[A-Z0-9_]+$|^enterprise_mode$/.test(error?.code ?? '') ? error.code : 'BOT_HOST_TOOL_REFUSED';
            reply = { ok: false, error: { code, status: error?.status >= 400 && error.status <= 599 ? error.status : 409,
              state: ['needs-you', 'outcome-unknown', 'failed', 'refused'].includes(error?.state) ? error.state : 'needs-you' } };
          }
          receipt = await receipts.write(key, { ...pending, state: 'settled', reply });
        }
        const settled = await execution.settleTool(entry, { ...pending, reply: receipt.reply });
        if (settled?.settled !== true) refuse('BOT_HOST_TOOL_SETTLEMENT_UNKNOWN');
        forwarded++;
      });
    }
    return { forwarded };
  };
  return { forward };
}
