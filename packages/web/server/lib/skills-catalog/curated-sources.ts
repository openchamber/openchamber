import { readEnterprisePolicy } from '../enterprise-mode.js';
import type { EnterprisePolicyOptions } from '../enterprise-mode.js';

export interface CuratedSkillsSource {
  id: string;
  label: string;
  description: string;
  source: string;
  defaultSubpath?: string;
  sourceType: 'github';
  excludedSkills?: string[];
}

const CURATED_SKILLS_SOURCES: CuratedSkillsSource[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: "Anthropic's public skills repository",
    source: 'anthropics/skills',
    defaultSubpath: 'skills',
    sourceType: 'github',
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

export function getCuratedSkillsSources(policyOptions?: EnterprisePolicyOptions) {
  if (readEnterprisePolicy(policyOptions).hideBuiltinSkillCatalogs) return [];
  return CURATED_SKILLS_SOURCES.slice();
}
