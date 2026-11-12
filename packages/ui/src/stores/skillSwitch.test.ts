import { describe, expect, test } from 'bun:test';
import type { IntegrationPolicy } from '@/lib/opencode/projection';
import { applySkillSwitch, filterAvailableSkills, getSkillSwitchState, keepSwitchedOffSkills, skillIdFromPath } from './skillSwitch';

const statement = (resource: string, effect: 'allow' | 'deny', path: string | null = '/home/u/.config/opencode/opencode.json'): IntegrationPolicy => ({ resource, effect, path });

describe('skill switches', () => {
  test('a skill id is its folder, a loose file name, or a built-in skill name', () => {
    expect(skillIdFromPath('/repo/.agents/skills/deploy-docs/SKILL.md', 'Deploy docs')).toBe('deploy-docs');
    expect(skillIdFromPath('C:\\skills\\deploy\\SKILL.md', 'deploy')).toBe('deploy');
    expect(skillIdFromPath('/home/u/.config/opencode/skill/review.md', 'Review')).toBe('review');
    expect(skillIdFromPath('<built-in>', 'customize-opencode')).toBe('customize-opencode');
  });

  test('the last matching statement decides; only an exact deny or an allow leaves the switch usable', () => {
    expect(getSkillSwitchState([], 'deploy')).toEqual({ enabled: true, rule: null, switchable: true });

    const exact = statement('skill:deploy', 'deny');
    expect(getSkillSwitchState([exact], 'deploy')).toEqual({ enabled: false, rule: exact, switchable: true });

    const wildcard = statement('skill:dep*', 'deny');
    expect(getSkillSwitchState([wildcard], 'deploy')).toEqual({ enabled: false, rule: wildcard, switchable: false });

    // A deny from config with no file has nowhere to be removed from.
    const fileless = statement('skill:deploy', 'deny', null);
    expect(getSkillSwitchState([fileless], 'deploy')).toEqual({ enabled: false, rule: fileless, switchable: false });

    const allow = statement('skill:*', 'allow');
    expect(getSkillSwitchState([exact, allow], 'deploy')).toEqual({ enabled: true, rule: allow, switchable: true });
    expect(getSkillSwitchState([allow, exact], 'deploy').enabled).toBe(false);
  });

  test('only switched-off skills leave the available list, which stays the same array otherwise', () => {
    const skills = [{ id: 'deploy' }, { id: 'review' }];
    expect(filterAvailableSkills(skills, [])).toBe(skills);
    expect(filterAvailableSkills(skills, [statement('mcp:*', 'deny')])).toBe(skills);
    expect(filterAvailableSkills(skills, [statement('skill:deploy', 'deny')])).toEqual([{ id: 'review' }]);
  });

  test('a write shows before OpenCode reloads: off adds the deciding deny, on drops every exact deny', () => {
    const wildcard = statement('skill:internal-*', 'deny');
    const off = applySkillSwitch([wildcard], 'deploy', false, ['/repo/opencode.json']);
    expect(off).toEqual([wildcard, statement('skill:deploy', 'deny', '/repo/opencode.json')]);
    expect(getSkillSwitchState(off, 'deploy').enabled).toBe(false);
    expect(applySkillSwitch([wildcard], 'deploy', false, [])).toEqual([wildcard]);

    // On drops the denies of the files the server changed; one with no file stays.
    const fileless = statement('skill:deploy', 'deny', null);
    const on = applySkillSwitch([statement('skill:deploy', 'deny'), fileless, ...off], 'deploy', true, ['/home/u/.config/opencode/opencode.json', '/repo/opencode.json']);
    expect(on).toEqual([fileless, wildcard]);
  });

  test('a switched-off skill OpenCode no longer lists keeps its row, so it can be turned back on', () => {
    const fromId = (id: string) => ({ id, name: id });
    const builtIn = { id: 'opencode', name: 'OpenCode' };
    const listed = [{ id: 'review', name: 'review' }];
    const policies = [statement('skill:opencode', 'deny'), statement('skill:gone', 'deny'), statement('skill:internal-*', 'deny')];

    expect(keepSwitchedOffSkills(listed, [builtIn], policies, fromId)).toEqual([...listed, builtIn, { id: 'gone', name: 'gone' }]);
    expect(keepSwitchedOffSkills(listed, [builtIn], [], fromId)).toBe(listed);
    expect(keepSwitchedOffSkills(listed, [builtIn], [statement('skill:opencode', 'deny'), statement('skill:*', 'allow')], fromId)).toBe(listed);
  });
});
