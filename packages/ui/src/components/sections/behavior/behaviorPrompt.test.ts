import { describe, expect, test } from 'bun:test';

import { resolveBehaviorPrompt } from './behaviorPrompt';

describe('resolveBehaviorPrompt', () => {
  test('uses an existing non-empty file over the persisted prompt', () => {
    expect(resolveBehaviorPrompt({ kind: 'file', content: 'from file' }, 'from settings'))
      .toBe('from file');
  });

  test('keeps an existing empty file authoritative', () => {
    expect(resolveBehaviorPrompt({ kind: 'file', content: '' }, 'from settings'))
      .toBe('');
  });

  test('preserves whitespace-only file content as-is', () => {
    expect(resolveBehaviorPrompt({ kind: 'file', content: '  \n' }, 'from settings'))
      .toBe('  \n');
  });

  test('falls back to the persisted prompt when the file is missing', () => {
    expect(resolveBehaviorPrompt({ kind: 'missing' }, 'from settings'))
      .toBe('from settings');
  });

  test('resolves to an empty string when neither source has content', () => {
    expect(resolveBehaviorPrompt({ kind: 'missing' }, undefined))
      .toBe('');
  });
});
