import { describe, expect, test } from 'bun:test';
import { generateBranchName, generateBranchSlug, generatedBranchPrefix } from './branchNameGenerator';

describe('generatedBranchPrefix', () => {
  test('recognizes every name the generator makes, with the dialog suffix too', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generatedBranchPrefix(generateBranchName())).toBe('');
      expect(generatedBranchPrefix(`${generateBranchSlug()}-${Date.now().toString(36).slice(-4)}`)).toBe('');
    }
  });

  test('keeps the prefix of an issue, discussion or tracker branch', () => {
    expect(generatedBranchPrefix(`issue-180-${generateBranchSlug()}`)).toBe('issue-180-');
    expect(generatedBranchPrefix(`discussion-12-${generateBranchSlug()}`)).toBe('discussion-12-');
    expect(generatedBranchPrefix(`issue-ENG-12-${generateBranchSlug()}`)).toBe('issue-ENG-12-');
  });

  test('leaves names someone chose alone', () => {
    for (const name of ['fix/login-timeout', 'feature/cosmic-dolphin', 'feature-cosmic-dolphin', 'issue-42-login-timeout', 'cosmic-dolphins', 'main']) {
      expect(generatedBranchPrefix(name)).toBeNull();
    }
  });
});
