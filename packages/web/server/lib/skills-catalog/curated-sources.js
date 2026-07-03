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
    id: 'clawdhub',
    label: 'ClawdHub',
    description: 'Community skill registry with vector search',
    source: 'clawdhub:registry',
    sourceType: 'clawdhub',
  },
];

export function getCuratedSkillsSources() {
  return CURATED_SKILLS_SOURCES.slice();
}
