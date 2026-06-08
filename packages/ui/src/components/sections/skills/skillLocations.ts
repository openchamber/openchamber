import type { SkillScope, SkillSource } from '@/stores/useSkillsStore';

export type SkillLocationValue = 'user-opencode' | 'project-opencode' | 'user-claude' | 'project-claude' | 'user-agents' | 'project-agents';

export const SKILL_LOCATION_OPTIONS: Array<{
  value: SkillLocationValue;
  scope: SkillScope;
  source: SkillSource;
  label: string;
  description: string;
}> = [
  {
    value: 'user-opencode',
    scope: 'user',
    source: 'opencode',
    label: 'User / OpenCode',
    description: 'Global OpenCode config location',
  },
  {
    value: 'project-opencode',
    scope: 'project',
    source: 'opencode',
    label: 'Project / OpenCode',
    description: 'Current project .opencode location',
  },
  {
    value: 'user-agents',
    scope: 'user',
    source: 'agents',
    label: 'User / Agents',
    description: 'Global .agents compatibility location',
  },
  {
    value: 'project-agents',
    scope: 'project',
    source: 'agents',
    label: 'Project / Agents',
    description: 'Current project .agents compatibility location',
  },
];

export function locationValueFrom(scope: SkillScope, source: SkillSource): SkillLocationValue {
  if (scope === 'project' && source === 'claude') return 'project-claude';
  if (scope === 'project' && source === 'agents') return 'project-agents';
  if (source === 'claude') return 'user-claude';
  if (scope === 'project') return 'project-opencode';
  if (source === 'agents') return 'user-agents';
  return 'user-opencode';
}

export function locationPartsFrom(value: SkillLocationValue): { scope: SkillScope; source: SkillSource } {
  if (value === 'user-claude') return { scope: 'user', source: 'claude' };
  if (value === 'project-claude') return { scope: 'project', source: 'claude' };
  const match = SKILL_LOCATION_OPTIONS.find((option) => option.value === value);
  if (!match) {
    return { scope: 'user', source: 'opencode' };
  }
  return { scope: match.scope, source: match.source };
}

export function locationLabel(scope: SkillScope, source: SkillSource): string {
  if (scope === 'user' && source === 'claude') return 'User / Claude';
  if (scope === 'project' && source === 'claude') return 'Project / Claude';
  const match = SKILL_LOCATION_OPTIONS.find((option) => option.scope === scope && option.source === source);
  return match?.label || `${scope} / ${source}`;
}
