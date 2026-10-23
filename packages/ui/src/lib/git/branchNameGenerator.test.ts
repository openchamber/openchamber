import { describe, expect, test } from 'bun:test';
import { generateBranchName, generateBranchSlug, isGeneratedBranchName } from './branchNameGenerator';

describe('isGeneratedBranchName', () => {
  test('recognizes every name the generator makes, with the dialog suffix too', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(isGeneratedBranchName(generateBranchName())).toBe(true);
      expect(isGeneratedBranchName(`${generateBranchSlug()}-${Date.now().toString(36).slice(-4)}`)).toBe(true);
    }
  });

  test('leaves names someone chose alone', () => {
    for (const name of ['fix/login-timeout', 'feature/cosmic-dolphin', 'issue-42-cosmic-dolphin', 'cosmic-dolphins', 'main']) {
      expect(isGeneratedBranchName(name)).toBe(false);
    }
  });
});
