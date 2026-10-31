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

  describe('plain HTTP sources', () => {
    const machine = (origins) => ({
      policy: {
        platform: 'linux',
        env: {},
        readFile: (filePath) => {
          if (filePath !== '/etc/openchamber/policy.json') throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
          return JSON.stringify({ enterpriseMode: true, allowedInsecureGitOrigins: origins });
        },
      },
    });

    it('are refused unless their origin is listed in allowedInsecureGitOrigins', () => {
      expect(parseSkillRepoSource('http://gitlab.corp.internal:8080/platform/skills.git', machine([])))
        .toMatchObject({ ok: false, error: { kind: 'invalidSource' } });
      expect(parseSkillRepoSource('http://gitlab.corp.internal:8080/platform/skills.git', machine(['http://gitlab.corp.internal:9090'])))
        .toMatchObject({ ok: false, error: { kind: 'invalidSource' } });
    });

    it('are read like https sources when the origin is listed, keeping the scheme and port', () => {
      expect(parseSkillRepoSource('http://gitlab.corp.internal:8080/platform/team/skills.git#v2', machine(['http://gitlab.corp.internal:8080']))).toMatchObject({
        ok: true,
        host: 'gitlab.corp.internal',
        owner: 'platform/team',
        repo: 'skills',
        cloneUrlHttps: 'http://gitlab.corp.internal:8080/platform/team/skills.git',
        cloneUrlSsh: 'ssh://git@gitlab.corp.internal:8080/platform/team/skills.git',
        ref: 'v2',
      });
    });

    it('keep the scp-style ssh URL when the source names no port', () => {
      expect(parseSkillRepoSource('http://gitlab.corp.internal/platform/skills.git', machine(['http://gitlab.corp.internal'])))
        .toMatchObject({ ok: true, cloneUrlSsh: 'git@gitlab.corp.internal:platform/skills.git' });
    });

    it('leave https sources as they were', () => {
      expect(parseSkillRepoSource('https://gitlab.corp.internal/platform/skills.git', machine([])))
        .toMatchObject({ ok: true, cloneUrlHttps: 'https://gitlab.corp.internal/platform/skills.git' });
    });
  });
});
