/**
 * Narrowing the discovered skill list to what the agent can actually invoke.
 *
 * OpenChamber scans every root it knows about. OpenCode loads a narrower set,
 * governed by environment flags the browser cannot read — the server reports
 * them alongside the scan.
 *
 * OpenCode's own skill-list endpoint cannot serve as the authority here:
 * measured against 1.18.14, it returns only global and builtin skills and omits
 * the project `.agents`/`.claude` skills the agent demonstrably has. Mirroring
 * its discovery rules is the only way to match what the agent sees.
 *
 * The rules, from `opencode/src/skill/index.ts`:
 *
 * - `OPENCODE_DISABLE_EXTERNAL_SKILLS` drops `.claude` and `.agents` entirely;
 * - `OPENCODE_DISABLE_CLAUDE_CODE` (broad) or `..._CLAUDE_CODE_SKILLS`
 *   (specific) drops `.claude` only — `.agents` is always scanned;
 * - names are deduplicated, last scan winning, and `.agents` is scanned after
 *   `.claude`, so `.agents` wins a collision. This matters here because
 *   `.claude/skills` entries are commonly symlinks back into `.agents/skills`.
 */

type ExternalSkillFlags = {
  /** `.claude` roots are not loaded. */
  claudeDisabled: boolean;
  /** Neither `.claude` nor `.agents` roots are loaded. */
  allDisabled: boolean;
};

type SkillLike = { name: string; path: string };

const CLAUDE_ROOT = /(^|\/)\.claude\//;
const AGENTS_ROOT = /(^|\/)\.agents\//;

type SkillRoot = 'claude' | 'agents' | 'opencode';

export const resolveSkillRoot = (skillPath: string): SkillRoot => {
  // Server discovery joins paths with the platform separator, so Windows
  // skill paths arrive with backslashes. Normalize before matching the
  // root regexes, which are expressed with forward slashes.
  const normalized = skillPath.replace(/\\/g, '/');
  if (CLAUDE_ROOT.test(normalized)) return 'claude';
  if (AGENTS_ROOT.test(normalized)) return 'agents';
  return 'opencode';
};

export const filterSkillsByRuntimeFlags = <T extends SkillLike>(
  skills: readonly T[],
  flags: ExternalSkillFlags | null | undefined,
): T[] => {
  // No flags reported means an older server or a failed read. Filtering on a
  // guess would hide skills that do work, so the list passes through.
  if (!flags) return [...skills];

  const allowed = skills.filter((skill) => {
    const root = resolveSkillRoot(skill.path);
    if (root === 'opencode') return true;
    if (flags.allDisabled) return false;
    if (root === 'claude') return !flags.claudeDisabled;
    return true;
  });

  // Deduplicate by name, preferring `.agents` — the same order OpenCode's
  // last-write-wins scan produces.
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
