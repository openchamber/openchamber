import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsInset,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
  SETTINGS_HELPER_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { isValidCronExpression } from '@/lib/cron';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { getSuggestedTasksRuntime, useSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { useSuggestedTasksSettingsStore } from '@/stores/useSuggestedTasksSettingsStore';
import { useSuggestedTasksGit } from './useSuggestedTasksGit';
import {
  runSuggestionScan,
  SUGGESTION_LEVELS,
  SUGGESTION_SEVERITIES,
  type LensPreset,
  type RepositoryLens,
  type SuggestedTaskLens,
  type SuggestedTasksConfig,
} from '@/lib/suggestedTasksApi';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { canonicalizeTimezone, TIMEZONE_OPTIONS } from '@/lib/timezones';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { SuggestedLensEditorDialog } from './SuggestedLensEditorDialog';
import { LENS_ACTION_TEXT } from './suggestedLensActions';

const PRESET_NAME = new Map<string, I18nKey>([
  ['todo-fixme', 'suggestedTasks.preset.todoFixme'],
  ['security', 'suggestedTasks.preset.security'],
  ['performance', 'suggestedTasks.preset.performance'],
  ['accessibility', 'suggestedTasks.preset.accessibility'],
  ['test-coverage', 'suggestedTasks.preset.testCoverage'],
  ['dependencies', 'suggestedTasks.preset.dependencies'],
  ['docs', 'suggestedTasks.preset.docs'],
  ['dead-code', 'suggestedTasks.preset.deadCode'],
]);

const WEEKDAYS: Array<{ value: number; label: I18nKey }> = [
  { value: 1, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.mon' },
  { value: 2, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.tue' },
  { value: 3, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.wed' },
  { value: 4, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.thu' },
  { value: 5, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.fri' },
  { value: 6, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.sat' },
  { value: 0, label: 'sessions.scheduledTasks.dialog.schedule.weekdayShort.sun' },
];

const LEVEL_LABEL = {
  low: 'suggestedTasks.confidence.low',
  medium: 'suggestedTasks.confidence.medium',
  high: 'suggestedTasks.confidence.high',
} satisfies Record<(typeof SUGGESTION_LEVELS)[number], I18nKey>;
const SEVERITY_LABEL = {
  low: 'suggestedTasks.severity.low',
  medium: 'suggestedTasks.severity.medium',
  high: 'suggestedTasks.severity.high',
  critical: 'suggestedTasks.severity.critical',
} satisfies Record<(typeof SUGGESTION_SEVERITIES)[number], I18nKey>;

const REPO_STATUS = {
  enabled: 'suggestedTasks.settings.repoLens.enabled',
  disabled: 'suggestedTasks.settings.repoLens.disabled',
  changed: 'suggestedTasks.settings.repoLens.changed',
  invalid: 'suggestedTasks.settings.repoLens.invalid',
} satisfies Record<RepositoryLens['status'], I18nKey>;

const DEFAULT_TOKEN_BUDGET = 500_000;

const createLensId = (): string => `lens-${crypto.randomUUID().slice(0, 12)}`;

/** A text field written when it loses focus, so typing does not save every keystroke. */
const CommitInput: React.FC<{ value: string; ariaLabel: string; placeholder?: string; type?: string; className?: string; onCommit: (value: string) => void }> = ({ value, ariaLabel, placeholder, type, className, onCommit }) => {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <Input
      dir="ltr"
      value={draft}
      type={type}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      className={className}
    />
  );
};

const GlobList: React.FC<{ value: string[]; ariaLabel: string; placeholder: string; onCommit: (value: string[]) => void }> = ({ value, ariaLabel, placeholder, onCommit }) => {
  const joined = value.join('\n');
  const [draft, setDraft] = React.useState(joined);
  React.useEffect(() => setDraft(joined), [joined]);
  return (
    <Textarea
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.split('\n').map((line) => line.trim()).filter(Boolean);
        if (next.join('\n') !== joined) onCommit(next);
      }}
      className="min-h-[72px] w-full font-mono text-xs"
      dir="ltr"
    />
  );
};

/**
 * A project's Suggested tasks settings, shown by the Configure dialog:
 * whether and when scans run, the lenses they run, what they look at, how
 * much they may report and cost, and what happens after. Each change is
 * saved on its own.
 */
const SuggestedTasksSettings: React.FC<{ projectRef: ProjectRef }> = ({ projectRef }) => {
  const projectId = projectRef.id;
  const { t } = useI18n();
  const timeFormat = useUIStore((state) => state.timeFormatPreference);
  const entry = useSuggestedTasksSettingsStore((state) => state.entries[projectId]);
  const settings = entry?.settings;
  const loadError = entry?.error;
  const runtime = getSuggestedTasksRuntime();
  const git = useSuggestedTasksGit(projectRef.path);
  const active = React.useRef(true);
  const scanPending = React.useRef(false);
  const [scanning, setScanning] = React.useState(false);
  const [editing, setEditing] = React.useState<{ lens: SuggestedTaskLens; isNew: boolean } | null>(null);
  const load = React.useCallback(() => {
    void useSuggestedTasksSettingsStore.getState().load(projectId);
  }, [projectId]);
  React.useEffect(() => {
    active.current = true;
    load();
    return () => { active.current = false; };
  }, [load]);
  const current = () => active.current && !runtime.signal.aborted;
  const save = async (update: (config: SuggestedTasksConfig) => SuggestedTasksConfig): Promise<boolean> => {
    if (!current()) return false;
    const saved = await useSuggestedTasksSettingsStore.getState().updateConfig(projectId, update);
    if (current()) {
      const committed = useSuggestedTasksSettingsStore.getState().entries[projectId];
      if (!saved) toast.error(committed?.error ?? t('suggestedTasks.settings.saveFailed'));
    }
    return saved && current();
  };

  if (loadError && !settings) {
    return (
      <SettingsSection title={t('suggestedTasks.settings.title')} divider={false}>
        <p className={SETTINGS_HELPER_CLASS} style={{ color: 'var(--status-error)' }}>{t('suggestedTasks.settings.loadFailed', { error: loadError })}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>{t('suggestedTasks.error.retry')}</Button>
      </SettingsSection>
    );
  }
  if (!settings) {
    return (
      <div className="flex items-center gap-2 typography-meta text-muted-foreground">
        <Icon name="loader-4" className="size-4 animate-spin" /> {t('suggestedTasks.page.loading')}
      </div>
    );
  }

  const { config, repoLenses, presets, nextRunAt } = settings;
  const change = (update: (config: SuggestedTasksConfig) => SuggestedTasksConfig) => void save(update);
  const timezone = config.schedule.timezone ?? canonicalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

  const addFromPreset = (preset: LensPreset | null) => {
    setEditing({
      isNew: true,
      lens: {
        id: createLensId(),
        name: preset ? t(PRESET_NAME.get(preset.id) ?? 'suggestedTasks.preset.custom') : '',
        enabled: true,
        preset: preset?.id,
        prompt: preset?.prompt ?? '',
        model: { useDefaults: true },
        web: preset?.web ?? false,
        action: 'suggest',
        mcp: [],
        permissionMode: 'default',
      },
    });
  };

  const saveLens = (lens: SuggestedTaskLens) => {
    return save((current) => {
      const exists = current.lenses.some((entry) => entry.id === lens.id);
      return { ...current, lenses: exists ? current.lenses.map((entry) => entry.id === lens.id ? lens : entry) : [...current.lenses, lens] };
    });
  };

  const runLens = async (lensIds?: string[]) => {
    if (!current() || !config.enabled || entry?.saving || scanPending.current) return;
    scanPending.current = true;
    setScanning(true);
    try {
      await runSuggestionScan(projectId, lensIds);
      if (!current()) return;
      toast.success(t('suggestedTasks.toast.scanStarted'));
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('suggestedTasks.toast.scanFailed'));
    } finally {
      scanPending.current = false;
      if (current()) setScanning(false);
    }
  };

  const toggleRepoLens = async (lens: RepositoryLens, enabled: boolean) => {
    if (!current()) return;
    const saved = await useSuggestedTasksSettingsStore.getState().setRepositoryLens(projectId, lens.file, enabled);
    if (current()) {
      const committed = useSuggestedTasksSettingsStore.getState().entries[projectId];
      if (!saved) toast.error(committed?.error ?? t('suggestedTasks.settings.saveFailed'));
    }
  };

  const cronValid = config.schedule.kind !== 'cron' || isValidCronExpression(config.schedule.cron).valid;
  const enabledLensCount = config.lenses.filter((lens) => lens.enabled).length + repoLenses.filter((lens) => lens.status === 'enabled').length;

  return (
    <>
      {loadError || git.availability.status === 'error' ? (
        <div role="alert" className="mb-4 space-y-2">
          <p className={SETTINGS_HELPER_CLASS} style={{ color: 'var(--status-error)' }}>{loadError ?? (git.availability.status === 'error' ? git.availability.error : '')}</p>
          <Button size="sm" variant="outline" onClick={() => { load(); git.retry(); }}>{t('suggestedTasks.error.retry')}</Button>
        </div>
      ) : null}
      <SettingsSection
        title={t('suggestedTasks.settings.title')}
        info={t('suggestedTasks.settings.info')}
        divider={false}
      >
        <div className="space-y-3">
          <SettingsCheckboxRow checked={config.enabled} onChange={(enabled) => change((current) => ({ ...current, enabled }))} label={t('suggestedTasks.settings.enabled')} />
          <p className={SETTINGS_HELPER_CLASS}>
            {!config.enabled
              ? t('suggestedTasks.settings.status.off')
              : config.schedule.kind === 'manual'
                ? t('suggestedTasks.settings.status.manual')
                : nextRunAt
                  ? t('suggestedTasks.settings.status.next', { time: formatDateTimeForPreference(nextRunAt, timeFormat, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })
                  : t('suggestedTasks.settings.status.noNext')}
          </p>
          <Button size="sm" variant="outline" disabled={!config.enabled || enabledLensCount === 0 || entry?.saving || scanning} onClick={() => void runLens()}>
            <Icon name="play" className="size-4" /> {t('suggestedTasks.page.runNow')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('suggestedTasks.settings.schedule.title')} info={t('suggestedTasks.settings.schedule.info')}>
        <div className="space-y-4">
          <SettingsChipGroup
            value={config.schedule.kind}
            onChange={(kind) => change((current) => ({ ...current, schedule: { ...current.schedule, kind } }))}
            aria-label={t('suggestedTasks.settings.schedule.title')}
            options={[
              { value: 'manual', label: t('suggestedTasks.settings.schedule.manual') },
              { value: 'daily', label: t('suggestedTasks.settings.schedule.daily') },
              { value: 'weekly', label: t('suggestedTasks.settings.schedule.weekly') },
              { value: 'cron', label: t('suggestedTasks.settings.schedule.cron') },
            ]}
          />
          {config.schedule.kind === 'daily' || config.schedule.kind === 'weekly' ? (
            <SettingsFieldRow label={t('suggestedTasks.settings.schedule.time')}>
              <CommitInput type="time" value={config.schedule.time} ariaLabel={t('suggestedTasks.settings.schedule.time')} className="w-32" onCommit={(time) => change((current) => ({ ...current, schedule: { ...current.schedule, time } }))} />
            </SettingsFieldRow>
          ) : null}
          {config.schedule.kind === 'weekly' ? (
            <SettingsFieldRow label={t('suggestedTasks.settings.schedule.weekdays')}>
              <div role="group" aria-label={t('suggestedTasks.settings.schedule.weekdays')} className="flex flex-wrap gap-1">
                {WEEKDAYS.map((day) => {
                  const selected = config.schedule.weekdays.includes(day.value);
                  return (
                    <Button
                      key={day.value}
                      type="button"
                      variant="chip"
                      size="xs"
                      aria-pressed={selected}
                      disabled={selected && config.schedule.weekdays.length === 1}
                      onClick={() => change((current) => ({ ...current, schedule: { ...current.schedule, weekdays: selected ? current.schedule.weekdays.filter((value) => value !== day.value) : [...current.schedule.weekdays, day.value].sort() } }))}
                    >
                      {t(day.label)}
                    </Button>
                  );
                })}
              </div>
            </SettingsFieldRow>
          ) : null}
          {config.schedule.kind === 'cron' ? (
            <SettingsFieldRow label={t('suggestedTasks.settings.schedule.cronExpression')} info={t('suggestedTasks.settings.schedule.cronInfo')}>
              <CommitInput value={config.schedule.cron} ariaLabel={t('suggestedTasks.settings.schedule.cronExpression')} placeholder="0 9 * * 1-5" className="w-48 font-mono text-xs" onCommit={(cron) => change((current) => ({ ...current, schedule: { ...current.schedule, cron: cron.trim() } }))} />
            </SettingsFieldRow>
          ) : null}
          {!cronValid ? <p className={SETTINGS_HELPER_CLASS} style={{ color: 'var(--status-error)' }}>{t('suggestedTasks.settings.schedule.cronInvalid')}</p> : null}
          {config.schedule.kind !== 'manual' ? (
            <>
              <SettingsFieldRow label={t('suggestedTasks.settings.schedule.timezone')}>
                <Select value={timezone} onValueChange={(value) => change((current) => ({ ...current, schedule: { ...current.schedule, timezone: value } }))}>
                  <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('suggestedTasks.settings.schedule.timezone')}>
                    <SelectValue>{timezone}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONE_OPTIONS.map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
              <SettingsCheckboxRow
                checked={config.quietHours.enabled}
                onChange={(enabled) => change((current) => ({ ...current, quietHours: { ...current.quietHours, enabled } }))}
                label={t('suggestedTasks.settings.quietHours.enabled')}
                info={t('suggestedTasks.settings.quietHours.info')}
              />
              {config.quietHours.enabled ? (
                <SettingsInset className="flex flex-wrap items-center gap-2">
                  <span className="typography-ui-label text-muted-foreground">{t('suggestedTasks.settings.quietHours.from')}</span>
                  <CommitInput type="time" value={config.quietHours.start} ariaLabel={t('suggestedTasks.settings.quietHours.from')} className="w-32" onCommit={(start) => change((current) => ({ ...current, quietHours: { ...current.quietHours, start } }))} />
                  <span className="typography-ui-label text-muted-foreground">{t('suggestedTasks.settings.quietHours.to')}</span>
                  <CommitInput type="time" value={config.quietHours.end} ariaLabel={t('suggestedTasks.settings.quietHours.to')} className="w-32" onCommit={(end) => change((current) => ({ ...current, quietHours: { ...current.quietHours, end } }))} />
                </SettingsInset>
              ) : null}
            </>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('suggestedTasks.settings.lenses.title')}
        info={t('suggestedTasks.settings.lenses.info')}
      >
        <ul className="max-w-[44rem] divide-y divide-[var(--interactive-border)] overflow-hidden rounded-xl border border-[var(--interactive-border)]">
          {config.lenses.map((lens) => (
            <li key={lens.id} className="flex items-center gap-2 pe-2 transition-colors hover:bg-[var(--interactive-hover)]">
              <span className="ps-3">
                <Checkbox
                  checked={lens.enabled}
                  onChange={(enabled) => change((current) => ({ ...current, lenses: current.lenses.map((entry) => entry.id === lens.id ? { ...entry, enabled } : entry) }))}
                  ariaLabel={t('suggestedTasks.settings.lenses.enableAria', { name: lens.name })}
                />
              </span>
              <button
                type="button"
                onClick={() => setEditing({ lens, isNew: false })}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
              >
                <span className={cn('min-w-0 flex-1', !lens.enabled && 'opacity-60')}>
                  <span className="block truncate typography-ui-label text-foreground" dir="auto">{lens.name}</span>
                  <span className="block truncate typography-micro text-muted-foreground">
                    {lens.model.useDefaults ? t('suggestedTasks.settings.lenses.usesDefaults') : [lens.model.modelID, lens.model.variant, lens.model.agent].filter(Boolean).join(' · ')}
                    {lens.web ? ` · ${t('suggestedTasks.settings.lenses.web')}` : ''}
                  </span>
                </span>
                {lens.action !== 'suggest' ? <SettingsCardPill tone="warning">{t(LENS_ACTION_TEXT[lens.action].label)}</SettingsCardPill> : null}
              </button>
              <Button type="button" variant="ghost" size="sm" disabled={!config.enabled || !lens.enabled || entry?.saving || scanning} onClick={() => void runLens([lens.id])} aria-label={t('suggestedTasks.settings.lenses.runAria', { name: lens.name })}>
                <Icon name="play" className="size-4" />
              </Button>
            </li>
          ))}
          {repoLenses.map((lens) => (
            <li key={lens.id} className="flex items-center gap-2 pe-2">
              <span className="ps-3">
                <Checkbox
                  checked={lens.status === 'enabled'}
                  disabled={lens.status === 'invalid'}
                  onChange={(enabled) => void toggleRepoLens(lens, enabled)}
                  ariaLabel={t('suggestedTasks.settings.lenses.enableAria', { name: lens.name ?? lens.file })}
                />
              </span>
              <span className="min-w-0 flex-1 py-2">
                <span className="block truncate typography-ui-label text-foreground" dir="auto">{lens.name ?? lens.file}</span>
                <span className="block truncate font-mono typography-micro text-muted-foreground" dir="ltr" title={lens.file}>{lens.file}</span>
                {lens.error ? <span className="block typography-micro" style={{ color: 'var(--status-error)' }}>{lens.error}</span> : null}
              </span>
              <SettingsCardPill tone={lens.status === 'enabled' ? 'neutral' : 'warning'}>{t(REPO_STATUS[lens.status])}</SettingsCardPill>
              <Button type="button" variant="ghost" size="sm" disabled={!config.enabled || lens.status !== 'enabled' || entry?.saving || scanning} onClick={() => void runLens([lens.id])} aria-label={t('suggestedTasks.settings.lenses.runAria', { name: lens.name ?? lens.file })}>
                <Icon name="play" className="size-4" />
              </Button>
            </li>
          ))}
          <li>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-2.5 ps-3 text-start typography-ui-label text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
                >
                  <Icon name="add" className="size-4 shrink-0" />
                  {t('suggestedTasks.settings.lenses.add')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-60">
                <DropdownMenuLabel>{t('suggestedTasks.settings.lenses.presets')}</DropdownMenuLabel>
                {presets.map((preset) => (
                  <DropdownMenuItem key={preset.id} onClick={() => addFromPreset(preset)}>
                    {t(PRESET_NAME.get(preset.id) ?? 'suggestedTasks.preset.custom')}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => addFromPreset(null)}>{t('suggestedTasks.preset.custom')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        </ul>
        <p className={cn(SETTINGS_HELPER_CLASS, 'mt-2')}>{t('suggestedTasks.settings.lenses.repoHint')}</p>
      </SettingsSection>

      <SettingsSection title={t('suggestedTasks.settings.scope.title')} info={t('suggestedTasks.settings.scope.info')}>
        <SettingsTwoColumn>
          <SettingsStackedField label={t('suggestedTasks.settings.scope.include')}>
            <GlobList value={config.scope.include} ariaLabel={t('suggestedTasks.settings.scope.include')} placeholder="src/**" onCommit={(include) => change((current) => ({ ...current, scope: { ...current.scope, include } }))} />
          </SettingsStackedField>
          <SettingsStackedField label={t('suggestedTasks.settings.scope.exclude')}>
            <GlobList value={config.scope.exclude} ariaLabel={t('suggestedTasks.settings.scope.exclude')} placeholder="**/*.generated.ts" onCommit={(exclude) => change((current) => ({ ...current, scope: { ...current.scope, exclude } }))} />
          </SettingsStackedField>
        </SettingsTwoColumn>
        <div className="mt-4 space-y-3">
          <SettingsFieldRow label={t('suggestedTasks.settings.scope.baseBranch')} info={t('suggestedTasks.settings.scope.baseBranchInfo')}>
            <CommitInput value={config.scope.baseBranch} ariaLabel={t('suggestedTasks.settings.scope.baseBranch')} placeholder={t('suggestedTasks.settings.scope.baseBranchPlaceholder')} className="w-56 font-mono text-xs" onCommit={(baseBranch) => change((current) => ({ ...current, scope: { ...current.scope, baseBranch: baseBranch.trim() } }))} />
          </SettingsFieldRow>
          <SettingsCheckboxRow
            checked={config.scope.incremental}
            onChange={(incremental) => change((current) => ({ ...current, scope: { ...current.scope, incremental } }))}
            label={t('suggestedTasks.settings.scope.incremental')}
            info={t('suggestedTasks.settings.scope.incrementalInfo')}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('suggestedTasks.settings.limits.title')}>
        <div className="space-y-4">
          <SettingsFieldRow label={t('suggestedTasks.settings.limits.maxSuggestions')} info={t('suggestedTasks.settings.limits.maxSuggestionsInfo')}>
            <NumberInput
              value={config.limits.maxSuggestions}
              min={1}
              max={50}
              step={1}
              deferExternalValueWhileFocused
              onValueChange={(maxSuggestions) => change((current) => ({ ...current, limits: { ...current.limits, maxSuggestions } }))}
              aria-label={t('suggestedTasks.settings.limits.maxSuggestions')}
              className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
            />
          </SettingsFieldRow>
          <SettingsCheckboxRow
            checked={config.limits.tokenBudget !== null}
            onChange={(on) => change((current) => ({ ...current, limits: { ...current.limits, tokenBudget: on ? DEFAULT_TOKEN_BUDGET : null } }))}
            label={t('suggestedTasks.settings.limits.tokenBudget')}
            info={t('suggestedTasks.settings.limits.tokenBudgetInfo')}
          />
          {config.limits.tokenBudget !== null ? (
            <SettingsInset>
              <SettingsFieldRow label={t('suggestedTasks.settings.limits.tokens')}>
                <NumberInput
                  value={config.limits.tokenBudget}
                  min={10_000}
                  max={100_000_000}
                  step={50_000}
                  deferExternalValueWhileFocused
                  onValueChange={(tokenBudget) => change((current) => ({ ...current, limits: { ...current.limits, tokenBudget } }))}
                  aria-label={t('suggestedTasks.settings.limits.tokens')}
                  className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
                />
              </SettingsFieldRow>
            </SettingsInset>
          ) : null}
          <SettingsFieldRow label={t('suggestedTasks.settings.limits.minConfidence')} info={t('suggestedTasks.settings.limits.minConfidenceInfo')}>
            <Select value={config.limits.minConfidence} onValueChange={(value) => change((current) => ({ ...current, limits: { ...current.limits, minConfidence: SUGGESTION_LEVELS.find((level) => level === value) ?? 'low' } }))}>
              <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('suggestedTasks.settings.limits.minConfidence')}>
                <SelectValue>{(value) => t(LEVEL_LABEL[SUGGESTION_LEVELS.find((level) => level === value) ?? 'low'])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUGGESTION_LEVELS.map((level) => <SelectItem key={level} value={level}>{t(LEVEL_LABEL[level])}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('suggestedTasks.settings.limits.minSeverity')}>
            <Select value={config.limits.minSeverity} onValueChange={(value) => change((current) => ({ ...current, limits: { ...current.limits, minSeverity: SUGGESTION_SEVERITIES.find((severity) => severity === value) ?? 'low' } }))}>
              <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('suggestedTasks.settings.limits.minSeverity')}>
                <SelectValue>{(value) => t(SEVERITY_LABEL[SUGGESTION_SEVERITIES.find((severity) => severity === value) ?? 'low'])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUGGESTION_SEVERITIES.map((severity) => <SelectItem key={severity} value={severity}>{t(SEVERITY_LABEL[severity])}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        </div>
      </SettingsSection>

      <SettingsSection title={t('suggestedTasks.settings.feedback.title')} info={t('suggestedTasks.settings.feedback.info')}>
        <div className="space-y-1.5">
          <SettingsCheckboxRow checked={config.dedupe.dismissed} onChange={(dismissed) => change((current) => ({ ...current, dedupe: { ...current.dedupe, dismissed } }))} label={t('suggestedTasks.settings.feedback.dismissed')} />
          <SettingsCheckboxRow checked={config.dedupe.todos} onChange={(todos) => change((current) => ({ ...current, dedupe: { ...current.dedupe, todos } }))} label={t('suggestedTasks.settings.feedback.todos')} />
        </div>
      </SettingsSection>

      <SettingsSection title={t('suggestedTasks.settings.after.title')}>
        <div className="space-y-1.5">
          <SettingsCheckboxRow checked={config.notify} onChange={(notify) => change((current) => ({ ...current, notify }))} label={t('suggestedTasks.settings.after.notify')} />
          <SettingsCheckboxRow
            checked={config.archiveScanSessions}
            onChange={(archiveScanSessions) => change((current) => ({ ...current, archiveScanSessions }))}
            label={t('suggestedTasks.settings.after.archive')}
            info={t('suggestedTasks.settings.after.archiveInfo')}
          />
        </div>
      </SettingsSection>

      {editing ? (
        <SuggestedLensEditorDialog
          key={editing.lens.id}
          lens={editing.lens}
          projectId={projectId}
          directory={projectRef.path}
          canCreateWorktree={git.canCreateWorktree}
          isNew={editing.isNew}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={saveLens}
          onDelete={() => save((current) => ({ ...current, lenses: current.lenses.filter((entry) => entry.id !== editing.lens.id) }))}
        />
      ) : null}
    </>
  );
};

export const SuggestedTasksSettingsForm: React.FC<{ projectRef: ProjectRef }> = ({ projectRef }) => {
  const runtime = useSuggestedTasksRuntime();
  return <SuggestedTasksSettings key={`${runtime.generation}:${projectRef.id}:${projectRef.path}`} projectRef={projectRef} />;
};
