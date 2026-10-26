import React from 'react';
import { toast } from '@/components/ui';
import { SettingsChipGroup, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { getSkillSwitchState } from '@/stores/skillSwitch';
import { selectSkillPoliciesForDirectory, useSkillsStore, type DiscoveredSkill } from '@/stores/useSkillsStore';

type SkillUse = 'auto' | 'manual' | 'off';

const ALWAYS_ON = getSkillSwitchState([], '');

interface SkillUseFieldProps {
  /** The installed skill; null while a new skill is drafted, which cannot be off yet. */
  skill: DiscoveredSkill | null;
  directory: string | null;
  /** The skill file's "run only when called" flag, saved with the page. */
  manual: boolean;
  onManualChange: (manual: boolean) => void;
  /** The skill file cannot be edited (a built-in skill), so neither can the flag. */
  manualLocked: boolean;
}

/**
 * When agents use a skill: on their own, only when it is called by name, or
 * not at all. "When called" is a flag in the skill file; "Off" is a policy in
 * the OpenCode config that leaves the file alone (`skillSwitch.ts`). Off moves
 * only once the server has written the config, so a failed write leaves the
 * choice where it was.
 */
export const SkillUseField: React.FC<SkillUseFieldProps> = ({ skill, directory, manual, onManualChange, manualLocked }) => {
  const { t } = useI18n();
  const policies = useSkillsStore((state) => selectSkillPoliciesForDirectory(state, directory));
  const setSkillEnabled = useSkillsStore((state) => state.setSkillEnabled);
  const [saving, setSaving] = React.useState(false);
  // Statements never read: whether the skill is off is unknown, so nothing can be chosen yet.
  const unknown = skill !== null && policies === null;
  const { enabled, rule, switchable } = React.useMemo(
    () => (skill && policies ? getSkillSwitchState(policies, skill.id) : ALWAYS_ON),
    [policies, skill],
  );
  const value: SkillUse = !enabled ? 'off' : manual ? 'manual' : 'auto';

  const switchSkill = async (on: boolean): Promise<boolean> => {
    if (!skill) return false;
    setSaving(true);
    const saved = await setSkillEnabled(skill, on, directory);
    setSaving(false);
    if (!saved) toast.error(t('settings.skills.page.switch.failed'));
    return saved;
  };

  const change = async (next: SkillUse) => {
    if (next === value) return;
    if (next === 'off') {
      await switchSkill(false);
      return;
    }
    if (!enabled && !(await switchSkill(true))) return;
    if ((next === 'manual') !== manual) onManualChange(next === 'manual');
  };

  // A rule the choice does not own decides: a wildcard deny, or an allow.
  const ruleNote = (() => {
    if (unknown) return t('settings.skills.page.use.unknown');
    if (!rule || (rule.effect === 'deny' && switchable)) return undefined;
    const values = { rule: rule.resource, path: rule.path ?? '' };
    if (enabled) {
      return rule.path ? t('settings.skills.page.switch.keptOnByRule', values) : t('settings.skills.page.switch.keptOnByRuleNoFile', values);
    }
    return rule.path ? t('settings.skills.page.switch.offByRule', values) : t('settings.skills.page.switch.offByRuleNoFile', values);
  })();

  const locked = saving || unknown || !switchable;
  const options = [
    {
      value: 'auto' as const,
      label: t('settings.skills.page.use.auto'),
      tooltip: t('settings.skills.page.use.autoHint'),
      disabled: locked || (manual && manualLocked),
    },
    {
      value: 'manual' as const,
      label: t('settings.skills.page.use.manual'),
      tooltip: t('settings.skills.page.field.disableModelInvocationHint'),
      disabled: locked || (!manual && manualLocked),
    },
    ...(skill ? [{
      value: 'off' as const,
      label: t('settings.skills.page.use.off'),
      tooltip: t('settings.skills.page.switch.offHint'),
      disabled: locked,
    }] : []),
  ];

  return (
    <SettingsFieldRow
      label={t('settings.skills.page.use.label')}
      info={t('settings.skills.page.use.info')}
      description={ruleNote}
    >
      <SettingsChipGroup
        value={value}
        options={options}
        onChange={(next) => { void change(next); }}
        aria-label={t('settings.skills.page.use.label')}
      />
    </SettingsFieldRow>
  );
};
