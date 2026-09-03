import { describe, expect, test } from 'bun:test';

import {
  branchPickerOptions,
  classifyDiffLine,
  clampPullCreate,
  failedPullChecks,
  mergePullCreateValues,
  pullRequestStatusText,
  resolvePullRequestLabels,
} from './pull.ts';

describe('resolvePullRequestLabels', () => {
  test('fills host-style defaults and keeps a guest override', () => {
    expect(resolvePullRequestLabels({}).overview).toBe('Overview');
    expect(resolvePullRequestLabels({}).changes).toBe('Changes');
    expect(resolvePullRequestLabels({ attach: 'Pin' }).attach).toBe('Pin');
    expect(resolvePullRequestLabels({}).createEmptyBranch).toBe('Pick a branch');
    expect(resolvePullRequestLabels({ createEmptyBranch: 'Choose' }).createEmptyBranch).toBe('Choose');
  });
});

describe('classifyDiffLine', () => {
  test('marks add, delete, hunk, and meta lines', () => {
    expect(classifyDiffLine('+ok')).toBe('add');
    expect(classifyDiffLine('-old')).toBe('del');
    expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk');
    expect(classifyDiffLine('+++ b/file')).toBe('meta');
    expect(classifyDiffLine('--- a/file')).toBe('meta');
    expect(classifyDiffLine(' context')).toBe('ctx');
  });
});

describe('mergePullCreateValues', () => {
  test('keeps a typed title when a later update fills the base', () => {
    expect(mergePullCreateValues({
      title: 'Fix login',
      description: '',
      head: '',
      base: '',
      draft: false,
    }, { base: 'main' })).toEqual({
      title: 'Fix login',
      description: '',
      head: '',
      base: 'main',
      draft: false,
    });
  });
});

describe('branchPickerOptions', () => {
  test('maps branch names onto picker options', () => {
    expect(branchPickerOptions(['main', 'feature'])).toEqual([
      { id: 'main', label: 'main' },
      { id: 'feature', label: 'feature' },
    ]);
  });
});

describe('pullRequestStatusText', () => {
  test('joins state and mergeability', () => {
    const copy = resolvePullRequestLabels({});
    expect(pullRequestStatusText({
      id: '!12',
      title: 'Fix login',
      state: 'open',
      mergeable: false,
    }, copy)).toBe('open · Not mergeable');
    expect(pullRequestStatusText({
      id: '!12',
      title: 'Fix login',
      state: 'draft',
    }, copy)).toBe('draft');
  });
});

describe('clampPullCreate', () => {
  test('needs title, head, and base', () => {
    expect(clampPullCreate({
      title: '  ',
      description: 'Body',
      head: 'feature',
      base: 'main',
      draft: false,
    })).toBeNull();
    expect(clampPullCreate({
      title: 'Fix login',
      description: '  notes  ',
      head: 'feature',
      base: 'main',
      draft: true,
    })).toEqual({
      title: 'Fix login',
      description: 'notes',
      head: 'feature',
      base: 'main',
      draft: true,
    });
  });
});

describe('failedPullChecks', () => {
  test('keeps only failures', () => {
    expect(failedPullChecks([
      { id: '1', name: 'lint', state: 'success' },
      { id: '2', name: 'test', state: 'failure', detail: 'boom' },
      { id: '3', name: 'build', state: 'pending' },
    ])).toEqual([{ id: '2', name: 'test', state: 'failure', detail: 'boom' }]);
  });
});
