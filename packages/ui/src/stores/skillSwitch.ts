import { findIntegrationPolicy, type IntegrationPolicy } from '@/lib/opencode/projection';

export const skillIdFromPath = (path: string, name: string): string => {
  if (path === '<built-in>') return name;
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? '';
  if (file === 'SKILL.md') return parts.at(-2) ?? name;
  if (file.endsWith('.md')) return file.slice(0, -3) || name;
  return name;
};

interface SkillSwitchState {
  enabled: boolean;
  rule: IntegrationPolicy | null;
  switchable: boolean;
}

export const getSkillSwitchState = (policies: readonly IntegrationPolicy[], id: string): SkillSwitchState => {
  const resource = `skill:${id}`;
  const rule = findIntegrationPolicy(policies, resource);
  return {
    enabled: rule?.effect !== 'deny',
    rule,
    switchable: rule === null || rule.effect === 'allow' || (rule.resource === resource && rule.path !== null),
  };
};

export const filterAvailableSkills = <T extends { id: string }>(
  skills: T[],
  policies: readonly IntegrationPolicy[] | null,
): T[] => {
  if (!policies || policies.length === 0) return skills;
  const available = skills.filter((skill) => getSkillSwitchState(policies, skill.id).enabled);
  return available.length === skills.length ? skills : available;
};

export const keepSwitchedOffSkills = <T extends { id: string }>(
  skills: T[],
  previous: readonly T[],
  policies: readonly IntegrationPolicy[],
  fromId: (id: string) => T,
): T[] => {
  const listed = new Set(skills.map((skill) => skill.id));
  const deniedIds = policies.flatMap((policy) => {
    if (policy.effect !== 'deny' || !policy.resource.startsWith('skill:')) return [];
    const id = policy.resource.slice('skill:'.length);
    return /[*?]/.test(id) ? [] : [id];
  });
  const missing = [...new Set(deniedIds)]
    .filter((id) => !listed.has(id) && !getSkillSwitchState(policies, id).enabled);
  if (missing.length === 0) return skills;
  return [...skills, ...missing.map((id) => previous.find((skill) => skill.id === id) ?? fromId(id))];
};

export const applySkillSwitch = (
  policies: readonly IntegrationPolicy[],
  id: string,
  enabled: boolean,
  changed: readonly string[],
): IntegrationPolicy[] => {
  const resource = `skill:${id}`;
  if (!enabled) {
    return changed.length > 0 ? [...policies, { resource, effect: 'deny', path: changed[0] }] : [...policies];
  }
  return policies.filter((policy) => !(
    policy.resource === resource && policy.effect === 'deny' && policy.path !== null && changed.includes(policy.path)
  ));
};

export const isSwitchedOffByOwnDeny = (policies: readonly IntegrationPolicy[] | null, id: string): boolean => {
  if (!policies) return false;
  const state = getSkillSwitchState(policies, id);
  return !state.enabled && state.switchable;
};
