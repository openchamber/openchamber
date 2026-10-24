import { describe, expect, it } from 'vitest';
import {
  decideVerdictEvent,
  readRunningTools,
} from './turn-end-verdict.js';

describe('decideVerdictEvent', () => {
  const on = { workDone: true, reviewReady: true, waitingOnYou: true };

  it('fires nothing without scores', () => {
    expect(decideVerdictEvent(null, on)).toBeNull();
  });

  it('fires each event at its measured threshold', () => {
    expect(decideVerdictEvent({ wrapUp: 0.8, review: null, needsYou: null }, on)).toBe('workDone');
    expect(decideVerdictEvent({ wrapUp: null, review: 0.7, needsYou: null }, on)).toBe('reviewReady');
    expect(decideVerdictEvent({ wrapUp: null, review: null, needsYou: 0.8 }, on)).toBe('waitingOnYou');
  });

  it('stays quiet below the thresholds', () => {
    expect(decideVerdictEvent({ wrapUp: 0.79, review: 0.69, needsYou: 0.79 }, on)).toBeNull();
  });

  it('keeps one verdict per turn: done outranks waiting, waiting outranks a review', () => {
    expect(decideVerdictEvent({ wrapUp: 0.9, review: 0.9, needsYou: 0.9 }, on)).toBe('workDone');
    expect(decideVerdictEvent({ wrapUp: null, review: 0.9, needsYou: 0.9 }, on)).toBe('waitingOnYou');
  });

  it('never fires an event its own checkbox left off', () => {
    const onlyWaiting = { workDone: false, reviewReady: false, waitingOnYou: true };
    expect(decideVerdictEvent({ wrapUp: 0.99, review: null, needsYou: 0.99 }, onlyWaiting)).toBe('waitingOnYou');
    expect(decideVerdictEvent({ wrapUp: 0.99, review: null, needsYou: null }, onlyWaiting)).toBeNull();
  });

  it('never fires a question the turn did not ask', () => {
    expect(decideVerdictEvent({ wrapUp: null, review: null, needsYou: 0.99 }, on)).toBe('waitingOnYou');
    expect(decideVerdictEvent({ wrapUp: null, review: null, needsYou: null }, on)).toBeNull();
  });
});

describe('readRunningTools', () => {
  it('finds a running tool part among the recent messages', () => {
    const messages = [
      { type: 'assistant', content: [{ type: 'text', text: 'Running it in the background.' }] },
      { type: 'assistant', content: [{ type: 'tool', state: { status: 'running' } }] },
    ];
    expect(readRunningTools(messages)).toBe(true);
  });

  it('ignores completed tool parts and non-tool content', () => {
    const messages = [
      { type: 'user', content: [{ type: 'text', text: 'go' }] },
      { type: 'assistant', content: [{ type: 'tool', state: { status: 'completed' } }, { type: 'text', text: 'done' }] },
    ];
    expect(readRunningTools(messages)).toBe(false);
  });

  // The shapes are the chat's own (`ui/src/lib/opencode/background-shell`): a
  // call sent to the background settles at once with a running marker, and the
  // shell reports its end in a later synthetic message.
  const backgroundedCall = (shellID) => ({
    type: 'assistant',
    content: [{ type: 'tool', name: 'shell', state: { status: 'completed', metadata: { status: 'running', shellID, truncated: false } } }],
  });
  const shellCompletion = (shellID) => ({
    role: 'synthetic',
    metadata: { source: 'shell', shellID, state: 'completed', exit: 0 },
    text: 'done',
  });

  it('treats a backgrounded shell without its completion as still running', () => {
    expect(readRunningTools([backgroundedCall('sh_1')])).toBe(true);
    expect(readRunningTools([{ type: 'user', content: [{ type: 'text', text: 'go' }] }, backgroundedCall('sh_1')])).toBe(true);
  });

  it('stops pausing once the shell reports its end', () => {
    // Newest first on the page, like the API answers.
    expect(readRunningTools([shellCompletion('sh_1'), backgroundedCall('sh_1')])).toBe(false);
    expect(readRunningTools([backgroundedCall('sh_1'), shellCompletion('sh_1')])).toBe(false);
  });

  it('keeps pausing for the shell that has not ended', () => {
    const messages = [shellCompletion('sh_1'), backgroundedCall('sh_2'), backgroundedCall('sh_1')];
    expect(readRunningTools(messages)).toBe(true);
  });

  it('answers false when the page could not be read', () => {
    expect(readRunningTools(null)).toBe(false);
    expect(readRunningTools(undefined)).toBe(false);
  });
});
