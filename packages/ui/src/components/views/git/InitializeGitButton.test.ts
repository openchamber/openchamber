import { describe, expect, test } from 'bun:test';

import { canOfferGitInitialization } from './InitializeGitButton';

describe('canOfferGitInitialization', () => {
  test('offers an ordinary project directory', () => {
    expect(canOfferGitInitialization('/Users/me/project', '/Users/me')).toBe(true);
    expect(canOfferGitInitialization('C:\\Users\\me\\project', 'C:\\Users\\me')).toBe(true);
    expect(canOfferGitInitialization('/srv/project', null)).toBe(true);
  });

  test('never offers the home directory', () => {
    expect(canOfferGitInitialization('/Users/me', '/Users/me')).toBe(false);
    expect(canOfferGitInitialization('/Users/me/', '/Users/me')).toBe(false);
    expect(canOfferGitInitialization('c:\\users\\me', 'C:\\Users\\me\\')).toBe(false);
  });

  test('never offers a disk root', () => {
    expect(canOfferGitInitialization('/', '/Users/me')).toBe(false);
    expect(canOfferGitInitialization('C:\\', 'C:\\Users\\me')).toBe(false);
    expect(canOfferGitInitialization('D:', null)).toBe(false);
  });
});
