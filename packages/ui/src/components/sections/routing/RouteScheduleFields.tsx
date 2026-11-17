import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CommitInput } from '@/components/sections/routing/PoolTargetOptions';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsControlGroup,
} from '@/components/sections/shared/SettingsSection';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import type { GlobalSchedule, ScheduleList, ScheduleListValue, StoredSchedules } from '@/lib/routing/scheduleSchema';
import {
  WEEKDAYS,
  isTimezone,
  newSchedule,
  parseDaysOfMonth,
  parseList,
  readScheduleList,
  scheduleEffect,
  scheduleListValue,
  timeInputValue,
  toggleWeekday,
  windowWeekdays,
  withScheduleEffect,
  withScheduleField,
  withWindowField,
  type ScheduleEntry,
} from '@/lib/routing/routeSchedules';
import { cn } from '@/lib/utils';

type MatchField = 'targets' | 'providers' | 'models' | 'routes';

// A schedule inside a pool names that pool's targets; one across pools can
// also narrow by provider, model and pool (OpenCode's GlobalSchedule).
const MATCH_FIELDS = {
  pool: ['targets'],
  global: ['providers', 'models', 'targets', 'routes'],
} as const satisfies Record<'pool' | 'global', readonly MatchField[]>;

// Example patterns, shown as typed: they are config values, not prose.
const MATCH_PLACEHOLDERS = {
  targets: 'deepseek/*, openai/gpt-6-*',
  providers: 'deepseek',
  models: '*flash*',
  routes: 'cheap-pool',
} as const satisfies Record<MatchField, string>;

/** A text field that commits on blur or Enter, and only when `isValid` accepts the text. */
const CheckedInput: React.FC<{
  label: string;
  value: string;
  type?: 'text' | 'time';
  placeholder?: string;
  error: string;
  isValid: (text: string) => boolean;
  onCommit: (text: string) => void;
}> = ({ label, value, type = 'text', placeholder, error, isValid, onCommit }) => {
  const [draft, setDraft] = React.useState(value);
  const valid = isValid(draft.trim());

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (text: string) => {
    setDraft(text);
    const next = text.trim();
    if (isValid(next) && next !== value) onCommit(next);
  };

  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="typography-meta text-muted-foreground">{label}</span>
      <Input
        type={type}
        aria-label={label}
        aria-invalid={!valid}
        value={draft}
        placeholder={placeholder}
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
        }}
        className={cn('h-8 w-full min-w-0 rounded-md px-2', !valid && 'border-destructive')}
      />
      {valid ? null : <span className="typography-meta text-destructive">{error}</span>}
    </label>
  );
};

/**
 * A time field. A stored "9:30" shows as "09:30", the only form a time input
 * holds; shown raw it would read as empty and the next blur would erase it.
 * A stored value no time input can hold shows as text, with the error.
 */
const TimeField: React.FC<{
  label: string;
  stored: string | undefined;
  error: string;
  onCommit: (text: string) => void;
}> = ({ label, stored, error, onCommit }) => {
  const display = timeInputValue(stored);
  return (
    <CheckedInput
      label={label}
      type={display === null ? 'text' : 'time'}
      value={display ?? stored ?? ''}
      error={error}
      isValid={(text) => text === '' || timeInputValue(text) !== null}
      onCommit={onCommit}
    />
  );
};

/** An entry the editor cannot read, shown as stored. It can only be removed here. */
const StoredScheduleEntry: React.FC<{ number: number; stored: ScheduleListValue[number]; onRemove: () => void }> = ({ number, stored, onRemove }) => {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t('settings.pools.schedules.entry', { number })} className="space-y-2 rounded-md border border-border/40 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <p className={cn(SETTINGS_HELPER_CLASS, 'min-w-0 flex-1')}>{t('settings.pools.schedules.unreadable')}</p>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('settings.pools.schedules.remove')}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">{JSON.stringify(stored, null, 2)}</pre>
    </div>
  );
};

const ScheduleEditor: React.FC<{
  number: number;
  schedule: GlobalSchedule;
  matchFields: readonly MatchField[];
  weekdayLabels: readonly string[];
  onChange: (schedule: GlobalSchedule) => void;
  onRemove: () => void;
}> = ({ number, schedule, matchFields, weekdayLabels, onChange, onRemove }) => {
  const { t } = useI18n();
  const when = schedule.when ?? {};
  const days = windowWeekdays(when);
  const effect = scheduleEffect(schedule);
  const fieldLabel = 'typography-meta text-muted-foreground';

  const setWhen = (next: GlobalSchedule['when']) => onChange(withScheduleField(schedule, 'when', next));

  return (
    <div role="group" aria-label={t('settings.pools.schedules.entry', { number })} className="space-y-3 rounded-md border border-border/40 p-3">
      <div className="flex min-w-0 items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={fieldLabel}>{t('settings.pools.schedules.name')}</span>
          <CommitInput
            label={t('settings.pools.schedules.name')}
            value={schedule.id ?? ''}
            onCommit={(next) => onChange(withScheduleField(schedule, 'id', next || undefined))}
          />
        </label>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('settings.pools.schedules.remove')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        {matchFields.map((field) => (
          <label key={field} className="flex min-w-0 flex-col gap-1">
            <span className={fieldLabel}>{t(`settings.pools.schedules.${field}`)}</span>
            <CommitInput
              label={t(`settings.pools.schedules.${field}`)}
              value={(schedule[field] ?? []).join(', ')}
              placeholder={MATCH_PLACEHOLDERS[field]}
              onCommit={(next) => onChange(withScheduleField(schedule, field, parseList(next)))}
            />
          </label>
        ))}
      </div>

      <div className="space-y-1">
        <span className={fieldLabel}>{t('settings.pools.schedules.days')}</span>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((day) => (
            <Button
              key={day}
              size="xs"
              variant="chip"
              aria-pressed={days.includes(day)}
              onClick={() => setWhen(toggleWeekday(when, day))}
            >
              {weekdayLabels[day]}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <CheckedInput
          label={t('settings.pools.schedules.daysOfMonth')}
          value={(when.daysOfMonth ?? []).join(', ')}
          placeholder="1, 15, -1"
          error={t('settings.pools.schedules.daysOfMonthInvalid')}
          isValid={(text) => parseDaysOfMonth(text) !== null}
          onCommit={(text) => setWhen(withWindowField(when, 'daysOfMonth', parseDaysOfMonth(text) ?? undefined))}
        />
        <CheckedInput
          label={t('settings.pools.schedules.timezone')}
          value={when.timezone ?? ''}
          placeholder={t('settings.pools.schedules.timezonePlaceholder')}
          error={t('settings.pools.schedules.timezoneInvalid')}
          isValid={(text) => text === '' || isTimezone(text)}
          onCommit={(text) => setWhen(withWindowField(when, 'timezone', text || undefined))}
        />
        <TimeField
          label={t('settings.pools.schedules.start')}
          stored={when.start}
          error={t('settings.pools.schedules.timeInvalid')}
          onCommit={(text) => setWhen(withWindowField(when, 'start', text || undefined))}
        />
        <TimeField
          label={t('settings.pools.schedules.end')}
          stored={when.end}
          error={t('settings.pools.schedules.timeInvalid')}
          onCommit={(text) => setWhen(withWindowField(when, 'end', text || undefined))}
        />
      </div>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.schedules.windowHint')}</p>

      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className={fieldLabel}>{t('settings.pools.schedules.effect')}</span>
          <Select
            value={effect}
            onValueChange={(picked) =>
              onChange(withScheduleEffect(schedule, picked === 'weight' ? 'weight' : 'factor', schedule[effect] ?? 1))
            }
          >
            <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-full')} aria-label={t('settings.pools.schedules.effect')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="factor">{t('settings.pools.schedules.effect.factor')}</SelectItem>
              <SelectItem value="weight">{t('settings.pools.schedules.effect.weight')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <RangedNumberField
          label={t(`settings.pools.schedules.amount.${effect}`)}
          value={schedule[effect]}
          min={0.01}
          max={1000}
          step="any"
          placeholder="1"
          // An empty field goes back to 1; OpenCode drops a schedule that changes nothing.
          onCommit={(value) => onChange(withScheduleEffect(schedule, effect, value ?? 1))}
        />
      </div>

      <label className="flex min-w-0 flex-col gap-1">
        <span className={fieldLabel}>{t('settings.pools.schedules.note')}</span>
        <CommitInput
          label={t('settings.pools.schedules.note')}
          value={schedule.note ?? ''}
          onCommit={(next) => onChange(withScheduleField(schedule, 'note', next || undefined))}
        />
      </label>
    </div>
  );
};

/**
 * Time-bound weight changes, as a list of entries. `pool` edits one pool's
 * `schedules`; `global` edits `experimental.model_route_schedules` in the file
 * OpenChamber writes, and shows `otherFiles` (lists OpenCode also applies from
 * other config files) read-only. `schedules` is the list as stored; every edit
 * hands the whole list to `onChange`, entries the editor cannot read included.
 */
export const RouteScheduleFields: React.FC<{
  scope: 'pool' | 'global';
  schedules: ScheduleList | null | undefined;
  onChange: (schedules: ScheduleListValue) => void;
  otherFiles?: readonly { path: string; schedules: StoredSchedules }[];
  settingsItem?: string;
}> = ({ scope, schedules, onChange, otherFiles = [], settingsItem }) => {
  const { t } = useI18n();
  // useI18n re-renders this on a language change, so the Intl locale read here is current.
  const intlLocale = getCurrentIntlLocale();
  const weekdayLabels = React.useMemo(() => {
    const format = new Intl.DateTimeFormat(intlLocale, { weekday: 'short' });
    // 2023-01-01 was a Sunday, so day n of that week is weekday n.
    return WEEKDAYS.map((day) => format.format(new Date(2023, 0, 1 + day)));
  }, [intlLocale]);

  const entries = readScheduleList(schedules);
  const save = (next: readonly ScheduleEntry[]) => onChange(scheduleListValue(next));

  return (
    <SettingsControlGroup
      title={t(scope === 'pool' ? 'settings.pools.schedules.title' : 'settings.pools.schedules.globalTitle')}
      info={t(scope === 'pool' ? 'settings.pools.schedules.info' : 'settings.pools.schedules.globalInfo')}
      settingsItem={settingsItem}
      contentClassName="space-y-3"
    >
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.schedules.listHint')}</p>
      {entries === null ? (
        <div className="space-y-2">
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.schedules.unreadableList')}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">{JSON.stringify(schedules, null, 2)}</pre>
        </div>
      ) : (
        <>
          {entries.map((entry, index) =>
            entry.kind === 'schedule' ? (
              <ScheduleEditor
                key={index}
                number={index + 1}
                schedule={entry.schedule}
                matchFields={MATCH_FIELDS[scope]}
                weekdayLabels={weekdayLabels}
                onChange={(next) => save(entries.map((item, i) => (i === index ? { kind: 'schedule', schedule: next } : item)))}
                onRemove={() => save(entries.filter((_, i) => i !== index))}
              />
            ) : (
              <StoredScheduleEntry
                key={index}
                number={index + 1}
                stored={entry.stored}
                onRemove={() => save(entries.filter((_, i) => i !== index))}
              />
            ),
          )}
          <Button size="sm" variant="outline" onClick={() => save([...entries, { kind: 'schedule', schedule: newSchedule() }])}>
            {t('settings.pools.schedules.add')}
          </Button>
        </>
      )}
      {otherFiles.map((file) => (
        <div key={file.path} className="space-y-2">
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.schedules.otherFile', { path: file.path })}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{JSON.stringify(file.schedules, null, 2)}</pre>
        </div>
      ))}
    </SettingsControlGroup>
  );
};
