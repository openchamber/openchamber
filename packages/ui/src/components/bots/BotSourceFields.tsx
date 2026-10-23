import React from 'react';
import { SettingsCheckboxRow, SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { BotDefinition } from '@/lib/bots/config';
import { BotSelectField } from './BotFields';

type Props = { readonly bot: BotDefinition; readonly onChange: (patch: Partial<BotDefinition>) => void };

export function BotSourceFields({ bot, onChange }: Props) {
  const { t, locale } = useI18n();
  const schedule = bot.schedule;
  const updateSchedule = (patch: Partial<BotDefinition['schedule']>) => onChange({ schedule: { ...schedule, ...patch } });
  return <>
    <SettingsSection title={t('bots.mission')} divider={false} contentClassName="space-y-4">
      <SettingsStackedField label={t('bots.name')}><Input required aria-label={t('bots.name')} value={bot.name} onChange={(event) => onChange({ name: event.target.value })} /></SettingsStackedField>
      <SettingsStackedField label={t('bots.mission')} controlClassName="max-w-none w-full">
        <Textarea required aria-label={t('bots.mission')} value={bot.mission} onChange={(event) => onChange({ mission: event.target.value })} />
      </SettingsStackedField>
      <SettingsCheckboxRow label={t('sessions.scheduledTasks.editor.enabled.label')} checked={bot.enabled} onChange={(enabled) => onChange({ enabled })} />
    </SettingsSection>
    <SettingsSection title={t('bots.source')} contentClassName="space-y-4">
      <BotSelectField<BotDefinition['source']['kind']> label={t('bots.source')} value={bot.source.kind} options={[
        { value: 'manual', label: t('bots.manual') }, { value: 'jira', label: 'Jira' }, { value: 'investigation', label: t('bots.investigation') },
      ]} onChange={(kind) => {
        switch (kind) {
          case 'manual': onChange({ source: { kind } }); break;
          case 'jira': onChange({ source: { kind, jql: '', maxItems: 1 } }); break;
          case 'investigation': onChange({ source: { kind, prompt: '', maxItems: 1 } }); break;
        }
      }} />
      {bot.source.kind === 'jira' ? <SettingsStackedField label="JQL" controlClassName="max-w-none w-full">
        <Textarea required dir="ltr" aria-label="JQL" value={bot.source.jql} onChange={(event) => onChange({ source: { kind: 'jira', jql: event.target.value, maxItems: bot.source.kind === 'jira' ? bot.source.maxItems : 1 } })} />
      </SettingsStackedField> : null}
      {bot.source.kind === 'investigation' ? <SettingsStackedField label={t('bots.investigation')} controlClassName="max-w-none w-full">
        <Textarea required aria-label={t('bots.investigation')} value={bot.source.prompt} onChange={(event) => onChange({ source: { kind: 'investigation', prompt: event.target.value, maxItems: bot.source.kind === 'investigation' ? bot.source.maxItems : 1 } })} />
      </SettingsStackedField> : null}
      {bot.source.kind !== 'manual' ? <SettingsStackedField label={t('bots.maxItems')}>
        <NumberInput aria-label={t('bots.maxItems')} min={1} value={bot.source.maxItems} onValueChange={(maxItems) => { if (bot.source.kind !== 'manual') onChange({ source: { ...bot.source, maxItems } }); }} />
      </SettingsStackedField> : null}
    </SettingsSection>
    <SettingsSection title={t('bots.schedule')} contentClassName="space-y-4">
      <BotSelectField<BotDefinition['schedule']['kind']> label={t('bots.schedule')} value={schedule.kind} onChange={(kind) => updateSchedule({ kind })} options={[
        { value: 'manual', label: t('bots.manual') }, { value: 'daily', label: t('sessions.scheduledTasks.editor.scheduleType.daily') },
        { value: 'weekly', label: t('sessions.scheduledTasks.editor.scheduleType.weekly') }, { value: 'cron', label: 'Cron' },
      ]} />
      {schedule.kind === 'daily' || schedule.kind === 'weekly' ? <SettingsStackedField label={t('sessions.scheduledTasks.editor.time.label')}>
        <Input type="time" dir="ltr" aria-label={t('sessions.scheduledTasks.editor.time.label')} value={schedule.time} onChange={(event) => updateSchedule({ time: event.target.value })} />
      </SettingsStackedField> : null}
      {schedule.kind === 'weekly' ? <div className="flex flex-wrap gap-1" role="group" aria-label={t('sessions.scheduledTasks.editor.weekdays.label')}>
        {[0, 1, 2, 3, 4, 5, 6].map((day) => <Button key={day} size="sm" variant="chip" aria-pressed={schedule.weekdays.includes(day)} onClick={() => updateSchedule({ weekdays: schedule.weekdays.includes(day) ? schedule.weekdays.filter((value) => value !== day) : [...schedule.weekdays, day] })}>
          {new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + day))}
        </Button>)}
      </div> : null}
      {schedule.kind === 'cron' ? <SettingsStackedField label="Cron"><Input dir="ltr" required aria-label="Cron" value={schedule.cron} onChange={(event) => updateSchedule({ cron: event.target.value })} /></SettingsStackedField> : null}
      {schedule.kind !== 'manual' ? <SettingsStackedField label={t('sessions.scheduledTasks.editor.timezone.label')}>
        <Input dir="ltr" aria-label={t('sessions.scheduledTasks.editor.timezone.label')} value={schedule.timezone ?? ''} onChange={(event) => updateSchedule({ timezone: event.target.value || undefined })} />
      </SettingsStackedField> : null}
    </SettingsSection>
  </>;
}
