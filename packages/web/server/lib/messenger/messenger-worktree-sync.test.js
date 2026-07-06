import { describe, it, expect } from 'vitest';
import {
  formatWorktreeThreadName,
  summarizeWorktreeGitStatus,
} from './messenger-worktree-sync.js';

describe('formatWorktreeThreadName', () => {
  it('prefixes worktree branches and caps length', () => {
    expect(formatWorktreeThreadName({ branch: 'feature-auth' })).toBe('⬦ feature-auth');
    expect(formatWorktreeThreadName({ branch: 'feature-auth', statusSummary: '+2·dirty' })).toBe(
      '⬦ feature-auth (+2·dirty)',
    );
  });
});

describe('summarizeWorktreeGitStatus', () => {
  it('summarises ahead/behind/dirty state', () => {
    expect(summarizeWorktreeGitStatus({ ahead: 2, behind: 1, isDirty: true })).toBe('+2·-1·dirty');
    expect(summarizeWorktreeGitStatus({ ahead: 0, behind: 0, isDirty: false })).toBe('clean');
    expect(summarizeWorktreeGitStatus(null)).toBeNull();
  });
});
