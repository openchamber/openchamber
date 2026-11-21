import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { frameContext, frameContextLimit, frameSessionFields, sameFrameSessionFields, selectFrameContextReading } from './session-usage';

const session = (input: number): Session => ({
  id: 's1', directory: '/project', projectID: 'project', title: 'Session', cost: 0,
  time: { created: 1, updated: 1 },
  tokens: { input, output: 20, reasoning: 0, cache: { read: 40, write: 10 } },
});

test('a frame observes counter changes without re-publishing unchanged totals', () => {
  const first = frameSessionFields(session(100));
  expect(first.tokens).toEqual({ prompt: 150, output: 20, reasoning: 0, cacheRead: 40, cacheWrite: 10, cacheHitPercent: 40 / 150 * 100 });
  expect(sameFrameSessionFields(first, frameSessionFields(session(100)))).toBe(true);
  expect(sameFrameSessionFields(first, frameSessionFields(session(200)))).toBe(false);
  expect(sameFrameSessionFields(first, frameSessionFields({ ...session(100), title: 'Renamed' }))).toBe(false);
  expect(frameSessionFields({ ...session(0), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }).tokens).toBeNull();
});

const assistant = (id: string, input: number, modelID = 'small') => ({ id, role: 'assistant', providerID: 'acme', modelID, tokens: { input } });
const providers = [{ id: 'acme', models: [{ id: 'small', limit: { context: 1000 } }, { id: 'large', limit: { context: 8000 } }] }];
const contextOf = (messages: Parameters<typeof selectFrameContextReading>[0]) => {
  const reading = selectFrameContextReading(messages);
  return frameContext(reading, frameContextLimit(reading, providers));
};

test('context fill resets after compaction and measures again at the next reply', () => {
  expect(contextOf([])).toBeNull();
  expect(contextOf([assistant('first', 150)])).toEqual({ tokens: 150, limit: 1000 });
  expect(contextOf([
    assistant('first', 150),
    { id: 'compact', role: 'compaction', status: 'completed' },
  ])).toBeNull();
  expect(contextOf([
    assistant('first', 150),
    { id: 'compact', role: 'compaction', status: 'completed' },
    assistant('next', 75),
  ])).toEqual({ tokens: 75, limit: 1000 });
});

test('the context window is the one of the model that answered the measured step', () => {
  // A later step that has not measured yet (switched model, no tokens) keeps the earlier reading's window.
  expect(contextOf([assistant('first', 150), { ...assistant('next', 0, 'large') }])).toEqual({ tokens: 150, limit: 1000 });
  expect(contextOf([assistant('first', 150), assistant('next', 300, 'large')])).toEqual({ tokens: 300, limit: 8000 });
  expect(contextOf([assistant('first', 150, 'unlisted')])).toEqual({ tokens: 150, limit: null });
  expect(contextOf([{ id: 'first', role: 'assistant', tokens: { input: 150 } }])).toEqual({ tokens: 150, limit: null });
});
