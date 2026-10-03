import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitPathUsesStagedDiff,
  formatCommitMessageForScm,
  parseGeneratedCommitMessage,
  selectCommitFilePaths,
} from './git-commit-message';

describe('git-commit-message', () => {
  test('uses staged paths when any exist, otherwise unstaged and untracked', () => {
    assert.deepEqual(selectCommitFilePaths([
      { path: 'staged.ts', index: 'M', working_dir: ' ' },
      { path: 'unstaged.ts', index: ' ', working_dir: 'M' },
    ]), ['staged.ts']);

    assert.deepEqual(selectCommitFilePaths([
      { path: 'unstaged.ts', index: ' ', working_dir: 'M' },
      { path: 'new.ts', index: '?', working_dir: '?' },
    ]), ['new.ts', 'unstaged.ts']);

    assert.equal(commitPathUsesStagedDiff({ path: 'both.ts', index: 'M', working_dir: 'M' }), true);
    assert.equal(commitPathUsesStagedDiff({ path: 'unstaged.ts', index: ' ', working_dir: 'M' }), false);
    assert.equal(commitPathUsesStagedDiff({ path: 'new.ts', index: '?', working_dir: '?' }), false);
  });

  test('formats a subject and optional highlight body for the SCM input', () => {
    assert.equal(formatCommitMessageForScm({
      subject: 'fix: handle empty diffs',
      highlights: ['Keep staged files', 'Fall back to unstaged'],
    }), 'fix: handle empty diffs\n\n- Keep staged files\n- Fall back to unstaged');

    assert.equal(formatCommitMessageForScm({
      subject: 'chore: bump deps',
      highlights: [],
    }), 'chore: bump deps');
  });

  test('parses structured commit JSON and rejects empty output', () => {
    assert.deepEqual(
      parseGeneratedCommitMessage('```json\n{"subject":"feat: add scm generate","highlights":["SCM title button"]}\n```'),
      {
        subject: 'feat: add scm generate',
        highlights: ['SCM title button'],
      },
    );
    assert.equal(parseGeneratedCommitMessage('sorry, I cannot help'), null);
  });
});
