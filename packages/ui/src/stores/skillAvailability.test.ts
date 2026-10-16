import { describe, expect, test } from 'bun:test';
import {
  filterAvailableSkills,
  knownSkillTokens,
  parseSkillPolicyRead,
  parseSkillPolicyWrite,
  resolveSkillMentions,
  resolveSkillToken,
  skillTokenFor,
  unlistedSwitchedOffIds,
  type SkillPolicyEntry,
  type SkillPolicyState,
} from './skillAvailability';

const entry = (effective: SkillPolicyEntry['effective'], disabledIn: SkillPolicyEntry['disabledIn'] = { global: false, project: false }): SkillPolicyEntry => ({
  disabledIn,
  effective,
  decidedBy: null,
});

const state = (skills: Record<string, SkillPolicyEntry>): SkillPolicyState => ({
  version: '2.0.29',
  location: 'policies',
  writable: true,
  effectiveAvailable: true,
  scopes: { global: { path: '/config/opencode.json', error: null }, project: null },
  skills: new Map(Object.entries(skills)),
});

const web = { id: 'deploy-web', name: 'deploy' };
const api = { id: 'deploy-api', name: 'deploy' };
const audit = { id: 'code-audit', name: 'audit' };

describe('filterAvailableSkills', () => {
  test('drops only skills the policy reports switched off', () => {
    const skills = [web, api, audit];
    const policy = state({ 'deploy-web': entry('disabled'), 'deploy-api': entry('unknown'), 'code-audit': entry('enabled') });
    expect(filterAvailableSkills(skills, policy)).toEqual([api, audit]);
  });

  test('keeps the same array when nothing is off, or nothing was read', () => {
    const skills = [web, audit];
    expect(filterAvailableSkills(skills, null)).toBe(skills);
    expect(filterAvailableSkills(skills, state({ 'deploy-web': entry('enabled') }))).toBe(skills);
  });
});

describe('skill tokens', () => {
  test('a shared display name names no skill; each id names its own', () => {
    const skills = [web, api, audit];
    expect(resolveSkillToken(skills, 'deploy')).toBeNull();
    expect(resolveSkillToken(skills, 'deploy-api')).toBe(api);
    expect(resolveSkillToken(skills, 'audit')).toBe(audit);
    expect(resolveSkillToken(skills, 'code-audit')).toBe(audit);
  });

  test('an id names its own skill even when another skill shows it as its name', () => {
    const named = { id: 'other-folder', name: 'review' };
    const folder = { id: 'review', name: 'Review helper' };
    expect(resolveSkillToken([named, folder], 'review')).toBe(folder);
    // Each skill still gets a token that names it.
    expect(skillTokenFor([named, folder], named)).toBe('other-folder');
    expect(skillTokenFor([named, folder], folder)).toBe('review');
  });

  test('a display name that cannot be typed as one token is inserted as the id', () => {
    const alpha = { id: 'alpha-skill', name: 'Alpha Display' };
    expect(skillTokenFor([alpha, audit], alpha)).toBe('alpha-skill');
    expect([...knownSkillTokens([alpha])]).toEqual(['alpha-skill']);
  });

  test('the picker inserts the id where the name is shared', () => {
    const skills = [web, api, audit];
    expect(skillTokenFor(skills, api)).toBe('deploy-api');
    expect(skillTokenFor(skills, audit)).toBe('audit');
    expect([...knownSkillTokens(skills)].sort()).toEqual(['audit', 'code-audit', 'deploy-api', 'deploy-web']);
  });

  test('mentions resolve once each, in order, leaving out shared names', () => {
    expect(resolveSkillMentions([web, api, audit], ['audit', 'deploy', 'deploy-api', 'code-audit'])).toEqual([
      { id: 'code-audit', name: 'audit' },
      { id: 'deploy-api', name: 'deploy-api' },
    ]);
  });
});

describe('policy parsing', () => {
  test('an error and an unknown shape are not a state', () => {
    expect(parseSkillPolicyRead({ error: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(parseSkillPolicyRead(undefined)).toEqual({ kind: 'absent' });
    expect(parseSkillPolicyRead({ ...state({}), skills: [] }).kind).toBe('state');
  });

  test('a write answer that is neither success nor error is a failure', () => {
    expect(parseSkillPolicyWrite(null, 502)).toEqual({ ok: false, code: 'invalid_response', message: 'Unexpected answer (HTTP 502)' });
    expect(parseSkillPolicyWrite({ ok: false, error: { code: 'write_failed', message: 'disk full' } }, 500))
      .toEqual({ ok: false, code: 'write_failed', message: 'disk full' });
  });
});

describe('unlistedSwitchedOffIds', () => {
  test('lists switched-off ids the inventory lacks', () => {
    const policy = state({
      'deploy-web': entry('disabled', { global: true, project: false }),
      'built-in-review': entry('disabled', { global: null, project: true }),
      'foreign-only': { ...entry('disabled'), decidedBy: { path: '/x.json', resource: 'skill:*', effect: 'deny', scope: 'other', owned: false } },
    });
    expect(unlistedSwitchedOffIds([web], policy)).toEqual(['built-in-review']);
  });
});
