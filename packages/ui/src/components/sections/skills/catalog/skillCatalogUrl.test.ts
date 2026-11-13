import { describe, expect, test } from 'bun:test';

import type { SkillsCatalogItem } from '@/lib/api/types';

import { skillCatalogUrl } from './skillCatalogUrl';

const item = (overrides: Partial<SkillsCatalogItem>): SkillsCatalogItem => ({
  sourceId: 'openai',
  repoSource: 'openai/skills',
  skillDir: 'skills/.curated/aspnet-core',
  skillName: 'aspnet-core',
  installable: true,
  ...overrides,
});

describe('skillCatalogUrl', () => {
  test('links a skill whose directory already carries the source subpath once', () => {
    // `skillDir` is the repo-root-relative directory the scanner read
    // (`git ls-files` / `git ls-tree` output), so it already contains the
    // source's subpath. Joining `repoSubpath` in front of it produced
    // `skills/.curated/skills/.curated/aspnet-core`, which GitHub answers 404.
    expect(skillCatalogUrl(item({ repoSubpath: 'skills/.curated' })))
      .toBe('https://github.com/openai/skills/tree/HEAD/skills/.curated/aspnet-core');
  });

  test('links a skill from a source without a subpath the same way', () => {
    expect(skillCatalogUrl(item({
      sourceId: 'mattpocock',
      repoSource: 'mattpocock/skills',
      skillDir: 'skills/tdd',
      skillName: 'tdd',
    }))).toBe('https://github.com/mattpocock/skills/tree/HEAD/skills/tdd');
  });

  test('links the repository itself when the item names no directory', () => {
    expect(skillCatalogUrl(item({ skillDir: '' }))).toBe('https://github.com/openai/skills');
  });

  test('offers no link for a source that is not an owner/repo shorthand', () => {
    // A custom source may be an SSH URL or a local path; there is no web page
    // to open, and a guessed URL would 404.
    expect(skillCatalogUrl(item({ repoSource: 'git@github.com:openai/skills.git' }))).toBeNull();
    expect(skillCatalogUrl(item({ repoSource: '/home/me/skills' }))).toBeNull();
  });
});
