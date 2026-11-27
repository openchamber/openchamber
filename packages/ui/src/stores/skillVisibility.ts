
type ExternalSkillFlags = {
  claudeDisabled: boolean;
};

type SkillLike = { name: string; path: string };

const CLAUDE_ROOT = /(^|\/)\.claude\//;
const AGENTS_ROOT = /(^|\/)\.agents\//;

type SkillRoot = 'claude' | 'agents' | 'opencode';

export const resolveSkillRoot = (skillPath: string): SkillRoot => {
  const normalized = skillPath.replace(/\\/g, '/');
  if (CLAUDE_ROOT.test(normalized)) return 'claude';
  if (AGENTS_ROOT.test(normalized)) return 'agents';
  return 'opencode';
};

export const filterSkillsByRuntimeFlags = <T extends SkillLike>(
  skills: readonly T[],
  flags: ExternalSkillFlags | null | undefined,
): T[] => {
  if (!flags) return [...skills];

  const allowed = skills.filter((skill) => !flags.claudeDisabled || resolveSkillRoot(skill.path) !== 'claude');

  const byName = new Map<string, T>();
  for (const skill of allowed) {
    const existing = byName.get(skill.name);
    if (!existing) {
      byName.set(skill.name, skill);
      continue;
    }
    if (resolveSkillRoot(existing.path) === 'claude' && resolveSkillRoot(skill.path) === 'agents') {
      byName.set(skill.name, skill);
    }
  }

  return [...byName.values()];
};
