import { SettingsCheckboxRow, SettingsChipGroup, SettingsFieldRow, SettingsSection, SettingsStackedField, SettingsTwoColumn } from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import type { BotDefinition } from '@/lib/bots/config';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { BotLimitField, BotSelectField } from './BotFields';
import { BotSpaceFields } from './BotSpaceFields';

export function BotExecutionFields({ bot, directory, onChange }: { readonly bot: BotDefinition; readonly directory: string; readonly onChange: (patch: Partial<BotDefinition>) => void }) {
  const { t } = useI18n();
  const safetyAvailable = useRoutingStore(selectSafetyNetAvailable);
  return <>
    <SettingsSection title={t('bots.execution')} divider={false} contentClassName="space-y-4">
      <SettingsFieldRow label={t('suggestedTasks.lens.editor.permissions')}>
        <SettingsChipGroup<BotDefinition['permissionMode']> value={bot.permissionMode} onChange={(permissionMode) => onChange({ permissionMode })} options={[
          { value: 'default', label: t('suggestedTasks.lens.editor.permissionDefault') }, { value: 'ask', label: t('settings.sessions.permissions.mode.ask') },
          { value: 'safety', label: t('settings.sessions.permissions.mode.safety'), disabled: !safetyAvailable }, { value: 'auto', label: t('settings.sessions.permissions.mode.auto') },
        ]} />
      </SettingsFieldRow>
      <div className="min-h-5 typography-meta" role="status">
        {bot.permissionMode === 'auto' ? <p className="text-[var(--status-warning-text)]">{t('suggestedTasks.lens.editor.autoWarning')}</p> : null}
        {!safetyAvailable ? <p className="text-muted-foreground">{t('settings.sessions.permissions.explain.safetyUnavailable')}</p> : null}
      </div>
      <BotSelectField<BotDefinition['notify']> label={t('sessions.scheduledTasks.editor.notify.label')} value={bot.notify} onChange={(notify) => onChange({ notify })} options={[
        { value: 'attention', label: t('sessions.scheduledTasks.editor.notify.attention') }, { value: 'finish', label: t('sessions.scheduledTasks.editor.notify.finish') },
      ]} />
      <SettingsCheckboxRow label={t('bots.isolated')} checked={bot.isolated} onChange={(isolated) => onChange({ isolated })} />
      <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.ambientWarning')}</p>
    </SettingsSection>
    {bot.isolated ? <BotSpaceFields bot={bot} directory={directory} onChange={onChange} /> : null}
    <SettingsSection title={t('bots.limits')}>
      <SettingsTwoColumn>
        <BotLimitField label={t('bots.goalTokens')} value={bot.goalTokenBudget} onChange={(goalTokenBudget) => onChange({ goalTokenBudget })} />
        <BotLimitField label={t('bots.dailyTokens')} value={bot.limits.dailyTokens} onChange={(dailyTokens) => onChange({ limits: { ...bot.limits, dailyTokens } })} />
        <BotLimitField label={t('bots.pendingHuman')} value={bot.limits.maxPendingHuman} onChange={(maxPendingHuman) => onChange({ limits: { ...bot.limits, maxPendingHuman } })} />
      </SettingsTwoColumn>
    </SettingsSection>
    <SettingsSection title={t('bots.proof')} contentClassName="space-y-4">
      <SettingsCheckboxRow label={t('bots.proof')} checked={bot.proof !== undefined} onChange={(enabled) => onChange({ proof: enabled ? { command: '', args: [] } : undefined })} />
      {bot.proof ? <>
        <SettingsStackedField label={t('bots.proofCommand')}><Input dir="ltr" required aria-label={t('bots.proofCommand')} value={bot.proof.command} onChange={(event) => onChange({ proof: { command: event.target.value, args: bot.proof?.args ?? [] } })} /></SettingsStackedField>
        <SettingsStackedField label={t('bots.proofArgs')} description={t('bots.proofArgsHint', { files: '{files}' })} controlClassName="max-w-none w-full">
          <Textarea dir="ltr" aria-label={t('bots.proofArgs')} value={bot.proof.args.join('\n')} onChange={(event) => onChange({ proof: { command: bot.proof?.command ?? '', args: event.target.value === '' ? [] : event.target.value.split('\n') } })} />
        </SettingsStackedField>
      </> : null}
      <SettingsStackedField label={t('bots.jiraTransition')}>
        <Input dir="ltr" aria-label={t('bots.jiraTransition')} value={bot.jira?.doneTransition ?? ''} onChange={(event) => onChange({ jira: event.target.value ? { doneTransition: event.target.value } : undefined })} />
      </SettingsStackedField>
    </SettingsSection>
  </>;
}
