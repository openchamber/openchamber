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

it.each([
  ['investigation', { summary: 'Observed', plan: 'Add a test, then fix', evidence: [] }],
  ['fixing', { summary: 'Fixed the cause' }],
  ['judge', { decision: 'auto', reason: 'Reviewed the exact diff' }],
])('reads a %s report that carries fields outside its contract, and drops them', (stage, report) => {
  // A judge that also echoed the SHAs it reviewed stopped a finished item.
  const parsed = parseBotStageOutput(stage, JSON.stringify({ ...report, testSha: 'a'.repeat(40), notes: 'extra' }));

  expect(parsed).toMatchObject(report);
  expect(parsed).not.toHaveProperty('testSha');
  expect(parsed).not.toHaveProperty('notes');
});

it('keeps an evidence entry whose url is not a URL or that carries extra keys, without the url', () => {
  const parsed = parseBotStageOutput('investigation', JSON.stringify({ summary: 'Observed', plan: 'Fix',
    evidence: [{ source: 'src/slugify.js', summary: 'Strips accents', url: 'src/slugify.js', line: 5 }] }));

  expect(parsed.evidence).toEqual([{ source: 'src/slugify.js', summary: 'Strips accents' }]);
});
