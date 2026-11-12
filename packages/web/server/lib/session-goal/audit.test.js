import { describe, expect, it } from 'vitest';

import {
  buildJevAuditRequest,
  buildSmallModelAuditPrompt,
  decideProgress,
  readJevAnswers,
  readSmallModelAnswers,
} from './audit.js';

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
