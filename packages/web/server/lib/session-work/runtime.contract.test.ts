import { expect, expectTypeOf, it } from 'vitest';
import { loadAssistContext } from '../session-assist/context.js';
import type { AssistTurn } from '../session-assist/contracts.js';

it('exposes only the checked final assistant as present', async () => {
  const context = await loadAssistContext({
    signal: new AbortController().signal,
    readPage: async () => ({
      data: [
        {
          id: 'answer',
          type: 'assistant',
          content: [{ type: 'text', text: 'Finished.' }],
          finish: 'stop',
          time: { completed: 2 },
          snapshot: { files: ['src/index.ts'] },
        },
        { id: 'request', type: 'user', text: 'Implement it.', time: { created: 1 } },
      ],
      cursor: {},
    }),
  });
  if (!context) throw new Error('Expected a completed context');
  const turn = context.turns.at(-1);
  expectTypeOf(turn.assistant.text).toEqualTypeOf<string>();
  expectTypeOf(turn.changedFiles).toEqualTypeOf<Set<string> | null>();
  expectTypeOf(context.turns.at(0)).toEqualTypeOf<AssistTurn | undefined>();
  expect(turn.assistant.text).toBe('Finished.');
  expect(turn.changedFiles).toEqual(new Set(['src/index.ts']));
  expect(context.last.providerID).toBeUndefined();
  expect(context.last.modelID).toBeUndefined();
});
