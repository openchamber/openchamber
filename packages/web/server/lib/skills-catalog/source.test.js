import { describe, expect, it } from 'vitest';

import { parseSkillRepoSource } from './source.js';

describe('parseSkillRepoSource', () => {
  it('reads a branch or tag after #, from shorthand and URLs', () => {
    expect(parseSkillRepoSource('acme/skills#develop')).toMatchObject({ ok: true, normalizedRepo: 'acme/skills', ref: 'develop', effectiveSubpath: null });
    expect(parseSkillRepoSource('acme/skills/pack#feature/v2')).toMatchObject({ ok: true, normalizedRepo: 'acme/skills', ref: 'feature/v2', effectiveSubpath: 'pack' });
    expect(parseSkillRepoSource('https://github.com/acme/skills.git#v1.0.0')).toMatchObject({
      ok: true,
      cloneUrlHttps: 'https://github.com/acme/skills.git',
      ref: 'v1.0.0',
    });
    expect(parseSkillRepoSource('git@gitlab.acme.dev:team/skills.git#beta')).toMatchObject({ ok: true, host: 'gitlab.acme.dev', ref: 'beta' });
  });

  it('has no ref without #, or with an empty one', () => {
    expect(parseSkillRepoSource('acme/skills').ref).toBeNull();
    expect(parseSkillRepoSource('acme/skills#').ref).toBeNull();
  });

  it('refuses a ref git would read as an option or a range', () => {
    for (const source of ['acme/skills#--upload-pack=x', 'acme/skills#a..b', 'acme/skills#x y']) {
      expect(parseSkillRepoSource(source), source).toMatchObject({ ok: false, error: { kind: 'invalidSource' } });
    }
  });
});
