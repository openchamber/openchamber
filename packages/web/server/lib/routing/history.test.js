import { describe, expect, it } from 'vitest';

import { excerptHead, excerptHeadTail, turnsToHistory } from './history.js';

const EMOJI = '\u{1F600}';

describe('excerptHead', () => {
  it('returns text at or under the limit unchanged', () => {
    expect(excerptHead('short', 600)).toBe('short');
  });

  it('cuts at the limit and appends the marker for plain text', () => {
    expect(excerptHead('a'.repeat(700), 600)).toBe(`${'a'.repeat(600)} […]`);
  });

  it('never ends the head on a lone high surrogate (#1910)', () => {
    // 599 BMP chars + an astral emoji straddling the 600 cut: the plain
    // slice would end on the high surrogate and encode as U+FFFD.
    const text = `${'a'.repeat(599)}${EMOJI}${'b'.repeat(100)}`;
    const cut = excerptHead(text, 600);
    expect(cut).toBe(`${'a'.repeat(599)} […]`);
    expect(Buffer.from(cut, 'utf8').toString('utf8')).toBe(cut);
  });

  it('keeps a pair that fits whole inside the limit', () => {
    const text = `${'a'.repeat(598)}${EMOJI}${'b'.repeat(100)}`;
    expect(excerptHead(text, 600)).toBe(`${'a'.repeat(598)}${EMOJI} […]`);
  });
});

describe('excerptHeadTail', () => {
  it('returns text at or under head + tail unchanged', () => {
    expect(excerptHeadTail('short', 300, 300)).toBe('short');
  });

  it('never starts the tail on a lone low surrogate (#1910)', () => {
    // The tail cut lands between the halves: the plain slice(-300) would
    // start on the low surrogate.
    const text = `${'a'.repeat(400)}${EMOJI}${'b'.repeat(299)}`;
    const cut = excerptHeadTail(text, 300, 300);
    expect(cut).toBe(`${'a'.repeat(300)} […] ${'b'.repeat(299)}`);
    expect(Buffer.from(cut, 'utf8').toString('utf8')).toBe(cut);
  });

  it('never ends the head on a lone high surrogate (#1910)', () => {
    const text = `${'a'.repeat(299)}${EMOJI}${'b'.repeat(400)}`;
    const cut = excerptHeadTail(text, 300, 300);
    expect(cut).toBe(`${'a'.repeat(299)} […] ${'b'.repeat(300)}`);
  });
});

describe('turnsToHistory', () => {
  it('applies the pair-safe cuts at the real HISTORY_LIMITS', () => {
    const turns = [{
      user: { text: `${'u'.repeat(599)}${EMOJI}${'u'.repeat(50)}` },
      assistant: { text: `${'a'.repeat(400)}${EMOJI}${'a'.repeat(299)}` },
    }];
    const history = turnsToHistory(turns);
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(Buffer.from(entry.text, 'utf8').toString('utf8')).toBe(entry.text);
    }
    expect(history[0].text).toBe(`${'u'.repeat(599)} […]`);
    expect(history[1].text).toBe(`${'a'.repeat(300)} […] ${'a'.repeat(299)}`);
  });
});
