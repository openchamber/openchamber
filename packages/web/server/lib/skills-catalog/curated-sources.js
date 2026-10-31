import { readEnterprisePolicy } from '../enterprise-mode.js';

const CURATED_SKILLS_SOURCES = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: "Anthropic's public skills repository",
    source: 'anthropics/skills',
    defaultSubpath: 'skills',
    sourceType: 'github',
    // These four ship under a proprietary LICENSE.txt that forbids copies
    // outside Anthropic's services; the rest of the repo is Apache 2.0.
    excludedSkills: ['docx', 'pdf', 'pptx', 'xlsx'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: "OpenAI's curated skills",
    source: 'openai/skills',
    defaultSubpath: 'skills/.curated',
    sourceType: 'github',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    description: "Cursor's plugin skills",
    source: 'cursor/plugins',
    defaultSubpath: 'pstack/skills',
    sourceType: 'github',
  },
  {
    id: 'mattpocock',
    label: 'Matt Pocock',
    description: 'Matt Pocock skills collection',
    source: 'mattpocock/skills',
    sourceType: 'github',
  },
];

/**
 * The catalogs on offer. The machine policy's `skillsCatalogSources` replaces
 * the built-in list (an administrator who names catalogs wants those, whether
 * or not the built-in ones are hidden); otherwise the built-in catalogs, or
 * none when the policy hides them.
 */
export function getCuratedSkillsSources(policyOptions) {
  const policy = readEnterprisePolicy(policyOptions);
  if (policy.skillsCatalogSources.length > 0) {
    return policy.skillsCatalogSources.map((entry) => {
      const source = { id: entry.id, label: entry.label, source: entry.source, sourceType: 'git' };
      if (entry.description) source.description = entry.description;
      if (entry.defaultSubpath) source.defaultSubpath = entry.defaultSubpath;
      if (entry.excludedSkills?.length) source.excludedSkills = [...entry.excludedSkills];
      return source;
    });
  }
  if (policy.hideBuiltinSkillCatalogs) return [];
  return CURATED_SKILLS_SOURCES.slice();
}
