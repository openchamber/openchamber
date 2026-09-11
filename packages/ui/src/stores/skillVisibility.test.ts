import { describe, expect, test } from 'bun:test';
import { filterSkillsByRuntimeFlags, resolveSkillRoot } from './skillVisibility';

const skill = (name: string, path: string) => ({ name, path });

const AGENTS = (name: string) => skill(name, `/repo/.agents/skills/${name}/SKILL.md`);
const CLAUDE = (name: string) => skill(name, `/repo/.claude/skills/${name}/SKILL.md`);
const OPENCODE = (name: string) => skill(name, `/home/u/.config/opencode/skill/${name}/SKILL.md`);
const WIN_AGENTS = (name: string) => skill(name, String.raw`C:\Users\u\.agents\skills\${name}\SKILL.md`);
const WIN_CLAUDE = (name: string) => skill(name, String.raw`C:\Users\u\.claude\skills\${name}\SKILL.md`);
const WIN_OPENCODE = (name: string) => skill(name, String.raw`C:\Users\u\.config\opencode\skill\${name}\SKILL.md`);

const ENABLED = { claudeDisabled: false, allDisabled: false };

describe('resolveSkillRoot', () => {
  test('classifies the external roots and everything else', () => {
    expect(resolveSkillRoot('/repo/.claude/skills/a/SKILL.md')).toBe('claude');
    expect(resolveSkillRoot('/repo/.agents/skills/a/SKILL.md')).toBe('agents');
    expect(resolveSkillRoot('/repo/.opencode/skills/a/SKILL.md')).toBe('opencode');
    expect(resolveSkillRoot('/home/u/.config/opencode/skill/a/SKILL.md')).toBe('opencode');
  });

  test('does not match a directory that merely contains the name', () => {
    expect(resolveSkillRoot('/repo/my.claude.backup/skills/a/SKILL.md')).toBe('opencode');
  });

  test('classifies Windows backslash paths', () => {
    expect(resolveSkillRoot(WIN_CLAUDE('a').path)).toBe('claude');
    expect(resolveSkillRoot(WIN_AGENTS('a').path)).toBe('agents');
    expect(resolveSkillRoot(WIN_OPENCODE('a').path)).toBe('opencode');
    expect(resolveSkillRoot(String.raw`C:\repo\my.claude.backup\skills\a\SKILL.md`)).toBe('opencode');
  });
});

describe('filterSkillsByRuntimeFlags', () => {
  test('passes everything through when the server reported no flags', () => {
    // An older server or a failed read must not hide skills that do work.
    const skills = [AGENTS('a'), CLAUDE('b'), OPENCODE('c')];
    expect(filterSkillsByRuntimeFlags(skills, null)).toHaveLength(3);
  });

  test('keeps every root when nothing is disabled', () => {
    const result = filterSkillsByRuntimeFlags([AGENTS('a'), CLAUDE('b'), OPENCODE('c')], ENABLED);
    expect(result.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
  });

  test('drops .claude but keeps .agents when claude skills are disabled', () => {
    // The specific flag governs `.claude` alone; `.agents` is always scanned.
    const result = filterSkillsByRuntimeFlags(
      [AGENTS('a'), CLAUDE('b'), OPENCODE('c')],
      { claudeDisabled: true, allDisabled: false },
    );
    expect(result.map((s) => s.name).sort()).toEqual(['a', 'c']);
  });

  test('drops both external roots when external skills are disabled', () => {
    const result = filterSkillsByRuntimeFlags(
      [AGENTS('a'), CLAUDE('b'), OPENCODE('c')],
      { claudeDisabled: false, allDisabled: true },
    );
    expect(result.map((s) => s.name)).toEqual(['c']);
  });

  test('prefers the .agents copy when a name exists in both roots', () => {
    // `.claude/skills` entries are commonly symlinks into `.agents/skills`;
    // OpenCode scans `.agents` last, so it wins the collision.
    const result = filterSkillsByRuntimeFlags([CLAUDE('dup'), AGENTS('dup')], ENABLED);
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('.agents');
  });

  test('keeps the single surviving copy of a duplicated name when .claude is disabled', () => {
    const result = filterSkillsByRuntimeFlags(
      [CLAUDE('dup'), AGENTS('dup')],
      { claudeDisabled: true, allDisabled: false },
    );
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('.agents');
  });

  test('does not let dedup drop a name that only exists under .claude', () => {
    const result = filterSkillsByRuntimeFlags([CLAUDE('only-claude'), AGENTS('other')], ENABLED);
    expect(result.map((s) => s.name).sort()).toEqual(['only-claude', 'other']);
  });

  test('drops Windows .agents and .claude skills when external skills are disabled', () => {
    const skills = [WIN_AGENTS('a'), WIN_CLAUDE('b'), WIN_OPENCODE('c')];
    const result = filterSkillsByRuntimeFlags(skills, { claudeDisabled: false, allDisabled: true });
    expect(result.map((s) => s.name)).toEqual(['c']);
  });

  test('drops only Windows .claude skills when claude skills are disabled', () => {
    const skills = [WIN_AGENTS('a'), WIN_CLAUDE('b'), WIN_OPENCODE('c')];
    const result = filterSkillsByRuntimeFlags(skills, { claudeDisabled: true, allDisabled: false });
    expect(result.map((s) => s.name).sort()).toEqual(['a', 'c']);
  });

  test('prefers the .agents copy for a duplicated name on Windows', () => {
    const result = filterSkillsByRuntimeFlags([WIN_CLAUDE('dup'), WIN_AGENTS('dup')], ENABLED);
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('.agents');
  });
});
