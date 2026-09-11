const CURATED_SKILLS_SOURCES = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: "Anthropic's public skills repository",
    source: 'anthropics/skills',
    defaultSubpath: 'skills',
    sourceType: 'github',
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

export function getCuratedSkillsSources() {
  return CURATED_SKILLS_SOURCES.slice();
}
