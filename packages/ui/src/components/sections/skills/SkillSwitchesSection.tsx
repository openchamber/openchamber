import React from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import type { SkillPolicyScope } from '@/stores/skillAvailability';
import {
  invalidateSkillsLoadCache,
  selectSkillPolicyForDirectory,
  skillSwitchKey,
  useSkillsStore,
} from '@/stores/useSkillsStore';
import { describeSkillAvailability, describeSwitchesUnavailable, switchedOffIn } from './skillSwitchStatus';

interface SkillSwitchesSectionProps {
  /** OpenCode's skill id: the switch applies to every copy of it. */
  id: string;
  /** The label the page shows for the skill. */
  name: string;
  /** The directory Settings shows, which the project switch writes for. */
  directory: string | null;
  divider?: boolean;
}

/**
 * The skill's on/off switches, one per config scope. Each shows the switch's
 * own rule in that scope's file; the line above says whether agents can use
 * the skill, which a rule the switches did not write can decide. Nothing moves
 * before the server answers: a failed save leaves the switch where it was.
 */
export const SkillSwitchesSection: React.FC<SkillSwitchesSectionProps> = ({ id, name, directory, divider = true }) => {
  const { t } = useI18n();
  const view = useSkillsStore((state) => selectSkillPolicyForDirectory(state, directory));
  const status = useSkillsStore((state) => state.switchStatus[skillSwitchKey(directory, id)]);
  const setSkillEnabled = useSkillsStore((state) => state.setSkillEnabled);
  const loadSkills = useSkillsStore((state) => state.loadSkills);

  const entry = view?.state?.skills.get(id);
  const availability = describeSkillAvailability(view, entry);
  const unavailable = describeSwitchesUnavailable(view);
  const pending = status?.phase === 'pending';
  const projectTarget = view?.state?.scopes.project ?? null;

  const toggle = async (scope: SkillPolicyScope, enabled: boolean) => {
    reportSettingsSaveState('saving');
    const result = await setSkillEnabled(id, scope, enabled, directory);
    // `pending`: another write for this skill is running, and it reports itself.
    if (!result.ok && result.code === 'pending') return;
    reportSettingsSaveState(result.ok ? 'saved' : 'error');
  };

  const checkAgain = () => {
    invalidateSkillsLoadCache(directory);
    void loadSkills(directory);
  };

  const renderSwitch = (scope: SkillPolicyScope) => {
    const target = scope === 'global' ? view?.state?.scopes.global : projectTarget;
    const off = switchedOffIn(view, entry, scope);
    const scopeStatus = status?.scope === scope ? status : undefined;
    return (
      <SettingsFieldRow
        label={scope === 'global'
          ? t('settings.skills.switches.global.label')
          : t('settings.skills.switches.project.label')}
        info={scope === 'global'
          ? t('settings.skills.switches.global.info', { id })
          : t('settings.skills.switches.project.info')}
        description={target?.error
          ? t('settings.skills.switches.scope.readFailed', { path: target.path, message: target.error })
          : undefined}
      >
        <Switch
          checked={off === false}
          disabled={off === null || unavailable !== null || pending}
          loading={scopeStatus?.phase === 'pending'}
          onCheckedChange={(checked) => { void toggle(scope, checked); }}
          aria-label={scope === 'global'
            ? t('settings.skills.switches.global.aria', { name })
            : t('settings.skills.switches.project.aria', { name })}
        />
      </SettingsFieldRow>
    );
  };

  return (
    <SettingsSection title={t('settings.skills.switches.title')} divider={divider} contentClassName="space-y-2">
      <p className={SETTINGS_HELPER_CLASS} role="status">
        {t(availability.key, availability.values)}
      </p>
      {view?.error ? (
        <p className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-error)]')} role="alert">
          {t('settings.skills.switches.status.readFailed', { message: view.error })}
        </p>
      ) : null}
      {unavailable && unavailable.key !== availability.key ? (
        <p className={SETTINGS_HELPER_CLASS}>{t(unavailable.key)}</p>
      ) : null}
      {renderSwitch('global')}
      {projectTarget ? renderSwitch('project') : null}
      {status?.phase === 'unconfirmed' ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <span className={SETTINGS_HELPER_CLASS}>{t('settings.skills.switches.write.unconfirmed')}</span>
          <Button size="xs" variant="outline" onClick={checkAgain}>
            {t('settings.skills.switches.write.checkAgain')}
          </Button>
        </div>
      ) : null}
      {status?.phase === 'failed' ? (
        <p className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-error)]')} role="alert">
          {t('settings.skills.switches.write.failed', { message: status.message })}
        </p>
      ) : null}
    </SettingsSection>
  );
};
