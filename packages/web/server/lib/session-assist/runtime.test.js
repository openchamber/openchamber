import { describe, expect, it } from 'vitest';

import { buildTranscript } from './runtime.js';

const message = (role, text, tools = []) => ({
  info: { role },
  parts: [
    ...(text ? [{ type: 'text', text }] : []),
    ...tools.map((tool) => ({ type: 'tool', tool })),
  ],
});

// Roughly 1 KB of body per message, against a 400 KB budget: ~400 messages
// cross it, so the trimming cases below are reached with round numbers.
const bulky = (role, index) => message(role, `${index}: ${'x'.repeat(1_000)}`);

const BUDGET = 400_000;
const conversation = (count) => Array.from({ length: count }, (_, i) => bulky(i % 2 === 0 ? 'user' : 'assistant', i));

describe('buildTranscript', () => {
  it('renders the whole conversation oldest first, numbered so the tail can point at the last message', () => {
    const { text, lastNumber, droppedOldest } = buildTranscript([
      message('user', 'open a bug report for the flaky upload'),
      message('assistant', 'filed it'),
    ], BUDGET);

    expect(lastNumber).toBe(2);
    expect(droppedOldest).toBe(0);
    expect(text).toBe('#1 User:\nopen a bug report for the flaky upload\n\n#2 Assistant:\nfiled it');
  });

  it('keeps tool names so a session that is mostly tool calls is not rendered as empty', () => {
    const { text } = buildTranscript([message('assistant', '', ['bash', 'bash', 'read'])], BUDGET);

    expect(text).toBe('#1 Assistant:\n[tools: bash×2, read]');
  });

  it('skips messages with no text and no tools rather than emitting an empty block', () => {
    const { text, lastNumber } = buildTranscript([
      message('user', 'hi'),
      message('assistant', ''),
      message('assistant', 'hello'),
    ], BUDGET);

    // Numbering follows the session, not the rendered list: the skipped message
    // keeps #2 reserved, so the tail of the prompt points at a number the
    // transcript actually contains.
    expect(text).toBe('#1 User:\nhi\n\n#3 Assistant:\nhello');
    expect(lastNumber).toBe(3);
  });

  // The reason the transcript is built this way: the prompt goes to the
  // session's own model, so an append-only prefix hits the backend's prefix
  // cache on the next assist. A transcript that shifted at the start every turn
  // would re-prefill the whole session each time.
  it('appends: a longer conversation extends the previous transcript instead of rewriting it', () => {
    const before = buildTranscript(conversation(10), BUDGET);
    const after = buildTranscript(conversation(12), BUDGET);

    expect(after.text.startsWith(before.text)).toBe(true);
  });

  it('drops the oldest messages on a fixed chunk boundary, so the prefix survives most turns', () => {
    const overBudget = conversation(700);
    const first = buildTranscript(overBudget, BUDGET);
    const second = buildTranscript([...overBudget, bulky('user', 700)], BUDGET);

    expect(first.droppedOldest).toBeGreaterThan(0);
    expect(first.droppedOldest % 16).toBe(0);
    expect(second.droppedOldest % 16).toBe(0);
    // One more message must not move the window: that is what makes the drop
    // amortized instead of per-turn.
    expect(second.droppedOldest).toBe(first.droppedOldest);
    expect(second.text.startsWith(first.text)).toBe(true);
  });

  it('never drops the last message, however small the budget is against it', () => {
    const { text, lastNumber } = buildTranscript(conversation(2_000), BUDGET);

    expect(lastNumber).toBe(2_000);
    expect(text).toContain('#2000 ');
  });
});
