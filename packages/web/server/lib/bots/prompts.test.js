import { expect, it } from 'vitest';
import { parseBotStageOutput } from './prompts.js';

it.each([
  ['investigation', { summary: 'Observed', plan: 'Clarify expected result', evidence: [], questions: ['Which behavior?'] }],
  ['judge', { decision: 'ask', reason: 'Expected behavior needs clarification', reviewers: [], questions: ['Which behavior?'] }],
])('preserves an optional requested role from %s while keeping existing reports valid', (stage, report) => {
  expect(parseBotStageOutput(stage, JSON.stringify(report))).toEqual(report);
  expect(parseBotStageOutput(stage, JSON.stringify({ ...report, requestedRole: 'tech-lead' }))).toEqual({ ...report, requestedRole: 'tech-lead' });
  expect(() => parseBotStageOutput(stage, JSON.stringify({ ...report, requestedRole: '' }))).toThrow();
  expect(() => parseBotStageOutput(stage, JSON.stringify({ ...report, requestedRole: 'x'.repeat(201) }))).toThrow();
});
