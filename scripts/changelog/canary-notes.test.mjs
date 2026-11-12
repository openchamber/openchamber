import { describe, expect, test } from 'bun:test';
import { NIGHTS_KEPT, addNight, collectChanges, nightDate } from './canary-notes.mjs';

describe('collectChanges', () => {
  test('keeps feat and fix commits a user sees, with their area and pull request', () => {
    expect(collectChanges([
      'feat(chat): remember thinking level per model (#5505)',
      'fix(providers): read vLLM-style limits in discovery (#5566) (#5571)',
      'fix: persist response style across session turns',
      'fix(ci): exempt maintainers from the contribution gate',
      'fix(deps): update dependency node-pty to v1.2.0-beta.18 (#5824)',
      'chore(triage): make batch PR triage repeatable',
      'docs(agents): sync communication-style',
    ])).toEqual({
      new: [{ area: 'chat', text: 'remember thinking level per model', pr: '5505' }],
      fixes: [
        { area: 'providers', text: 'read vLLM-style limits in discovery', pr: '5571' },
        { area: null, text: 'persist response style across session turns', pr: null },
      ],
    });
  });
});

describe('addNight', () => {
  const night = (version, fixes = [{ area: null, text: 'x', pr: null }]) => ({ version, date: nightDate(version), sha: 'a', new: [], fixes });

  test('puts the night first and keeps a bounded history', () => {
    const previous = Array.from({ length: NIGHTS_KEPT }, (_, index) => night(`2.5.4-canary.202610${String(index + 1).padStart(2, '0')}.${index + 1}`));
    const next = addNight(previous, night('2.5.4-canary.20261101.40'));
    expect(next).toHaveLength(NIGHTS_KEPT);
    expect(next[0].version).toBe('2.5.4-canary.20261101.40');
    expect(next[1].version).toBe('2.5.4-canary.20261001.1');
  });

  test('a re-run replaces its night, and an empty night adds nothing', () => {
    const previous = [night('2.5.4-canary.20261031.5')];
    expect(addNight(previous, night('2.5.4-canary.20261031.5', [{ area: 'chat', text: 'y', pr: null }]))).toHaveLength(1);
    expect(addNight(previous, night('2.5.4-canary.20261101.6', []))).toEqual(previous);
    expect(addNight(previous, night('2.5.4-canary.20261031.5', []))).toEqual(previous);
    expect(addNight('not json', night('2.5.4-canary.20261101.6'))).toHaveLength(1);
  });
});

test('nightDate reads the day out of a Canary version', () => {
  expect(nightDate('2.5.4-canary.20261031.5')).toBe('2026-10-31');
  expect(() => nightDate('2.5.4')).toThrow();
});
