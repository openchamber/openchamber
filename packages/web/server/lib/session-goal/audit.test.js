import { describe, expect, it } from 'vitest';

import {
  buildJevAuditRequest,
  buildSmallModelAuditPrompt,
  decideProgress,
  excerptObjective,
  readJevAnswers,
  readSmallModelAnswers,
} from './audit.js';

describe('objective excerpt for the check', () => {
  it('passes an objective within the limit whole', () => {
    expect(excerptObjective('short goal', 1_000)).toBe('short goal');
  });

  it('keeps the opening and the close of a longer one, within the limit', () => {
    const objective = `## Objective\nBuild it.\n${'middle '.repeat(5_000)}\n## Done when\nTests pass.`;
    const excerpt = excerptObjective(objective, 2_000);
    expect(excerpt.length).toBeLessThanOrEqual(2_000);
    expect(excerpt.startsWith('## Objective\nBuild it.')).toBe(true);
    expect(excerpt.endsWith('## Done when\nTests pass.')).toBe(true);
    expect(excerpt).toContain('middle of the objective left out');
  });
});

// A slice at a fixed offset can land between the halves of a surrogate pair; the
// lone half then encodes to U+FFFD in the judge's input. Every cut moves to the
// pair boundary instead (#1906).
const loneSurrogates = (text) => {
  const found = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const prev = text.charCodeAt(i - 1);
    const next = text.charCodeAt(i + 1);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh && !(next >= 0xdc00 && next <= 0xdfff)) found.push(i);
    if (isLow && !(prev >= 0xd800 && prev <= 0xdbff)) found.push(i);
  }
  return found;
};
const toFffd = (text) => Buffer.from(text, 'utf8').toString('utf8').includes('\uFFFD');

describe('excerpts never split a surrogate pair (#1906)', () => {
  const LIMIT = 2_000;
  const marker = '\n[… middle of the objective left out for this check …]\n';
  const head = Math.floor((LIMIT - marker.length) * 0.4);
  const tail = LIMIT - marker.length - head;

  it('moves the objective head cut to the pair boundary', () => {
    const objective = `${'a'.repeat(head - 1)}😀${'b'.repeat(5_000)}${'c'.repeat(tail)}`;
    const excerpt = excerptObjective(objective, LIMIT);
    expect(loneSurrogates(excerpt)).toEqual([]);
    expect(toFffd(excerpt)).toBe(false);
    expect(excerpt.length).toBeLessThanOrEqual(LIMIT);
    expect(excerpt.startsWith('a'.repeat(head - 1))).toBe(true);
  });

  it('moves the objective tail cut to the pair boundary', () => {
    // The tail slice starts on the emoji's low half, so the guard drops it and the pair is not split.
    const objective = `${'a'.repeat(head)}${'x'.repeat(5_000)}😀${'c'.repeat(tail - 1)}`;
    const excerpt = excerptObjective(objective, LIMIT);
    expect(loneSurrogates(excerpt)).toEqual([]);
    expect(toFffd(excerpt)).toBe(false);
    expect(excerpt.length).toBeLessThanOrEqual(LIMIT);
    expect(excerpt.endsWith('c'.repeat(tail - 1))).toBe(true);
  });

  it('moves the answer head cut to the pair boundary', () => {
    const answer = `${'a'.repeat(1_999)}😀${'b'.repeat(20_000)}`;
    const excerpt = buildJevAuditRequest({ objective: 'o', answer }).state.answer;
    expect(loneSurrogates(excerpt)).toEqual([]);
    expect(toFffd(excerpt)).toBe(false);
    expect(excerpt.startsWith('a'.repeat(1_999))).toBe(true);
  });

  it('moves the answer tail cut to the pair boundary', () => {
    // 30,000 units total; the emoji straddles the start of the last 8,000.
    const answer = `${'a'.repeat(22_000)}😀${'b'.repeat(7_998)}`;
    const excerpt = buildJevAuditRequest({ objective: 'o', answer }).state.answer;
    expect(loneSurrogates(excerpt)).toEqual([]);
    expect(toFffd(excerpt)).toBe(false);
    expect(excerpt.endsWith(`😀${'b'.repeat(7_998)}`)).toBe(true);
  });

  it('leaves an ASCII answer byte-identical', () => {
    const answer = `${'a'.repeat(2_000)}${'b'.repeat(20_000)}`;
    const excerpt = buildJevAuditRequest({ objective: 'o', answer }).state.answer;
    expect(excerpt).toBe(`${'a'.repeat(2_000)}\n[…]\n${'b'.repeat(8_000)}`);
  });
});

describe('goal progress decision', () => {
  it('blocks whenever the turn waits on the user, even with all work reported done', () => {
    expect(decideProgress({ all_done: 0.9, remaining: 0.1, needs_user: 0.7 })).toBe('blocked');
  });

  it('completes only when all is done and nothing is left for the agent', () => {
    expect(decideProgress({ all_done: 0.9, remaining: 0.1, needs_user: 0.1 })).toBe('complete');
    expect(decideProgress({ all_done: 0.9, remaining: 0.6, needs_user: 0.1 })).toBe('continue');
    expect(decideProgress({ all_done: 0.3, remaining: 0.1, needs_user: 0.1 })).toBe('continue');
  });
});

describe('Jev answers', () => {
  it('reads the three scores', () => {
    expect(readJevAnswers({ all_done: { noul: 0.8 }, remaining: { noul: 0.1 }, needs_user: { noul: 0.05 } }))
      .toEqual({ all_done: 0.8, remaining: 0.1, needs_user: 0.05 });
  });

  it('refuses an answer set with a question missing rather than guessing it', () => {
    expect(readJevAnswers({ all_done: { noul: 0.8 }, remaining: { noul: 0.1 } })).toBeNull();
  });

  it('keeps the closing report of a long turn', () => {
    const answer = `${'narrative '.repeat(3_000)}Remaining: wire the VS Code bridge.`;
    const request = buildJevAuditRequest({ objective: 'Ship it', answer });
    expect(request.state.answer.length).toBeLessThan(answer.length);
    expect(request.state.answer.endsWith('Remaining: wire the VS Code bridge.')).toBe(true);
  });
});

describe('small model answers', () => {
  it('reads the booleans as scores, also inside a code fence', () => {
    expect(readSmallModelAnswers('```json\n{"all_done": true, "remaining": false, "needs_user": false}\n```'))
      .toEqual({ all_done: 1, remaining: 0, needs_user: 0 });
  });

  it('refuses anything that is not the asked-for shape', () => {
    expect(readSmallModelAnswers('{"verdict": "complete"}')).toBeNull();
    expect(readSmallModelAnswers('{"all_done": "yes", "remaining": false, "needs_user": false}')).toBeNull();
    expect(readSmallModelAnswers('no json here')).toBeNull();
  });

  it('asks the same three questions Jev gets', () => {
    const prompt = buildSmallModelAuditPrompt({ objective: 'Ship it', answer: 'Done.' });
    for (const id of ['all_done', 'remaining', 'needs_user']) expect(prompt).toContain(`${id}:`);
    expect(prompt).toContain('<objective>\nShip it\n</objective>');
  });
});
