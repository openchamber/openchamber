import { describe, expect, it } from 'vitest';
import { getCuratedSkillsSources } from './curated-sources.js';

describe('getCuratedSkillsSources', () => {
  it('includes the Anthropic curated source', () => {
    const anthropic = getCuratedSkillsSources().find((source) => source.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic.label).toBe('Anthropic');
  });

  it('excludes the Anthropic skills whose license forbids copies', () => {
    const anthropic = getCuratedSkillsSources().find((source) => source.id === 'anthropic');
    expect(anthropic.excludedSkills).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
  });
});

describe('getCuratedSkillsSources with a machine policy', () => {
  const machine = (policy) => ({
    platform: 'linux',
    env: {},
    readFile: (filePath) => {
      if (filePath !== '/etc/openchamber/policy.json') throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      return Object.prototype.toString.call(policy) === '[object String]' ? policy : JSON.stringify(policy);
    },
  });
  const corp = { id: 'corp', label: 'Corp', description: 'Internal skills', source: 'https://gitlab.corp.test/platform/skills.git', defaultSubpath: 'skills', excludedSkills: ['draft'] };

  it('replaces the built-in catalogs with the ones the policy names', () => {
    expect(getCuratedSkillsSources(machine({ skillsCatalogSources: [corp] }))).toEqual([{ ...corp, sourceType: 'git' }]);
  });

  it('offers the replacement even when the built-in catalogs are hidden', () => {
    const sources = getCuratedSkillsSources(machine({ hideBuiltinSkillCatalogs: true, skillsCatalogSources: [corp] }));
    expect(sources.map((source) => source.id)).toEqual(['corp']);
  });

  it('leaves out the optional fields a policy entry does not set', () => {
    const [source] = getCuratedSkillsSources(machine({ skillsCatalogSources: [{ id: 'bare', label: 'Bare', source: 'https://gitlab.corp.test/a/b.git' }] }));
    expect(source).toEqual({ id: 'bare', label: 'Bare', source: 'https://gitlab.corp.test/a/b.git', sourceType: 'git' });
  });

  it('does not hand out the policy list itself', () => {
    const options = machine({ skillsCatalogSources: [corp] });
    getCuratedSkillsSources(options)[0].excludedSkills.push('mutated');
    expect(getCuratedSkillsSources(options)[0].excludedSkills).toEqual(['draft']);
  });

  it('keeps the built-in catalogs when the policy names none, and hides them on request', () => {
    expect(getCuratedSkillsSources(machine({ skillsCatalogSources: [] })).map((source) => source.id)).toContain('anthropic');
    expect(getCuratedSkillsSources(machine({ hideBuiltinSkillCatalogs: true }))).toEqual([]);
  });

  it('offers nothing when the policy file is broken', () => {
    expect(getCuratedSkillsSources(machine('{ not json'))).toEqual([]);
    expect(getCuratedSkillsSources(machine({ skillsCatalogSources: [{ id: 'no-source' }] }))).toEqual([]);
  });
});
