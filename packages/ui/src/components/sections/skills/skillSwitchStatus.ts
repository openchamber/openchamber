import type { SkillPolicyEntry, SkillPolicyScope } from '@/stores/skillAvailability';
import type { SkillPolicyView } from '@/stores/useSkillsStore';

/** A status line: a message key of `skillSwitchesI18n` and its values. */
type SkillSwitchMessage = {
  key:
    | 'settings.skills.switches.status.notRead'
    | 'settings.skills.switches.status.unreachable'
    | 'settings.skills.switches.status.unsupported'
    | 'settings.skills.switches.status.unknown'
    | 'settings.skills.switches.status.enabled'
    | 'settings.skills.switches.status.enabledByRule'
    | 'settings.skills.switches.status.offGlobal'
    | 'settings.skills.switches.status.offProject'
    | 'settings.skills.switches.status.blockedByRule'
    | 'settings.skills.switches.status.blockedByUnknownRule';
  values?: { path: string };
};

/**
 * Whether agents can use the skill and what decides it, from the policy the
 * server read. A rule the switches did not write is named with its file, since
 * no switch here can change it.
 */
export const describeSkillAvailability = (
  view: SkillPolicyView | null,
  entry: SkillPolicyEntry | undefined,
): SkillSwitchMessage => {
  const state = view?.state ?? null;
  if (!state) return { key: 'settings.skills.switches.status.notRead' };
  if (!entry || entry.effective === 'unknown') return { key: 'settings.skills.switches.status.unknown' };

  const decidedBy = entry.decidedBy;
  if (entry.effective === 'enabled') {
    return decidedBy?.effect === 'allow' && decidedBy.path
      ? { key: 'settings.skills.switches.status.enabledByRule', values: { path: decidedBy.path } }
      : { key: 'settings.skills.switches.status.enabled' };
  }
  if (decidedBy?.owned && decidedBy.scope === 'global') return { key: 'settings.skills.switches.status.offGlobal' };
  if (decidedBy?.owned && decidedBy.scope === 'project') return { key: 'settings.skills.switches.status.offProject' };
  return decidedBy?.path
    ? { key: 'settings.skills.switches.status.blockedByRule', values: { path: decidedBy.path } }
    : { key: 'settings.skills.switches.status.blockedByUnknownRule' };
};

/** Why the switches cannot be changed right now, or null when they can. */
export const describeSwitchesUnavailable = (view: SkillPolicyView | null): SkillSwitchMessage | null => {
  const state = view?.state ?? null;
  if (!state) return { key: 'settings.skills.switches.status.notRead' };
  if (state.writable) return null;
  return state.version
    ? { key: 'settings.skills.switches.status.unsupported' }
    : { key: 'settings.skills.switches.status.unreachable' };
};

/**
 * Whether the scope's file holds the switch's own rule, which is what its
 * switch shows: off only for a rule it wrote. Null when the file could not be
 * read, so the switch shows no position it cannot vouch for.
 */
export const switchedOffIn = (
  view: SkillPolicyView | null,
  entry: SkillPolicyEntry | undefined,
  scope: SkillPolicyScope,
): boolean | null => {
  const target = scope === 'global' ? view?.state?.scopes.global : view?.state?.scopes.project;
  if (!target || target.error) return null;
  return entry?.disabledIn[scope] === true;
};
