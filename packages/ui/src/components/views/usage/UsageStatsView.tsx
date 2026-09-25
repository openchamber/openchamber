import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import type { UsageModel, UsageStats } from '@/lib/opencode/session-stats';
import { formatDateTimeForPreference, formatTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';

import {
  USAGE_RANGES,
  buildActivitySeries,
  isEmptyReport,
  isSameLocalDay,
  projectDisplayName,
  type ActivityBar,
  type UsageRange,
} from './usageStatsModel';
import { selectUsageStatsEntry, useUsageStatsStore } from './usageStatsStore';

/** Select value for the unfiltered report; project values are OpenChamber project ids. */
const ALL_PROJECTS = '__all__';

const RANGE_LABEL_KEYS = {
  '7d': 'usageStats.range.7d',
  '30d': 'usageStats.range.30d',
  '90d': 'usageStats.range.90d',
  all: 'usageStats.range.all',
} as const satisfies Record<UsageRange, I18nKey>;

/**
 * The cached report for the chosen range and project (by directory). A key
 * with nothing cached loads on first view; a cached key never refetches on
 * its own. See `usageStatsStore.ts`.
 */
function useUsageStats(range: UsageRange, projectDirectory: string | null) {
  const request = React.useMemo(() => ({ range, projectDirectory }), [range, projectDirectory]);
  const entry = useUsageStatsStore((store) => selectUsageStatsEntry(store, request));
  const load = useUsageStatsStore((store) => store.load);

  // `entry` in the deps re-runs this after a runtime reset empties the cache.
  React.useEffect(() => {
    void load(request);
  }, [load, request, entry]);

  const refresh = React.useCallback(() => void load(request, { force: true }), [load, request]);
  return { entry, refresh };
}

export function UsageStatsView({ className }: { className?: string }): React.ReactNode {
  const { t } = useI18n();
  // Read during render: a locale change re-renders through useI18n.
  const intlLocale = getCurrentIntlLocale();
  const projects = useProjectsStore((store) => store.projects);
  const [range, setRange] = React.useState<UsageRange>('30d');
  const [projectChoice, setProjectChoice] = React.useState<string>(ALL_PROJECTS);
  // A project removed from the list while chosen falls back to all projects.
  const selectedProject = projects.find((project) => project.id === projectChoice) ?? null;
  const { entry, refresh } = useUsageStats(range, selectedProject?.path ?? null);
  const timeFormatPreference = useUIStore((store) => store.timeFormatPreference);
  const stats = entry?.stats ?? null;
  const loading = entry?.loading ?? true;

  const formats = React.useMemo(() => {
    return {
      integer: new Intl.NumberFormat(intlLocale),
      compact: new Intl.NumberFormat(intlLocale, { notation: 'compact', maximumFractionDigits: 1 }),
      cost: new Intl.NumberFormat(intlLocale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }),
      day: new Intl.DateTimeFormat(intlLocale, { month: 'short', day: 'numeric', year: 'numeric' }),
    };
  }, [intlLocale]);

  return (
    <div className={cn('h-full overflow-y-auto', className)}>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label={t('usageStats.range.label')} className="flex flex-wrap items-center gap-1">
            {USAGE_RANGES.map((option) => (
              <Button key={option} type="button" variant="chip" size="xs" aria-pressed={range === option} onClick={() => setRange(option)}>
                {t(RANGE_LABEL_KEYS[option])}
              </Button>
            ))}
          </div>
          <Select value={selectedProject ? selectedProject.id : ALL_PROJECTS} onValueChange={setProjectChoice}>
            <SelectTrigger size="sm" className="w-fit min-w-[140px] max-w-64" aria-label={t('usageStats.scope.label')}>
              <SelectValue>
                {() => (selectedProject ? projectDisplayName(selectedProject) : t('usageStats.scope.all'))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={ALL_PROJECTS}>{t('usageStats.scope.all')}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <span className="truncate" title={project.path}>{projectDisplayName(project)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {stats && entry?.fetchedAt ? (
              <span
                className="truncate typography-micro text-muted-foreground"
                title={entry.error ?? undefined}
                role={entry.error ? 'status' : undefined}
              >
                {t(entry.error ? 'usageStats.refresh.failed' : 'usageStats.refresh.updated', {
                  time: formatUpdatedAt(entry.fetchedAt, timeFormatPreference),
                })}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  onClick={refresh}
                  disabled={loading}
                  aria-label={t('usageStats.refresh.action')}
                >
                  <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>{t('usageStats.refresh.action')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {stats ? (
          isEmptyReport(stats) ? (
            <div className="flex flex-col items-center gap-1 py-16 text-center">
              <p className="typography-ui-label font-semibold text-foreground">{t('usageStats.empty.title')}</p>
              <p className="typography-micro text-muted-foreground">{t('usageStats.empty.description')}</p>
            </div>
          ) : (
            <UsageReport stats={stats} formats={formats} />
          )
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground" role="status">
            <Icon name="loader-4" className="size-4 animate-spin" />
            <span className="typography-ui-label">{t('usageStats.loading')}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-16 text-center" role="alert">
            <p className="typography-ui-label font-semibold text-foreground">{t('usageStats.error.title')}</p>
            <p className="max-w-md break-words typography-micro text-muted-foreground">{entry?.error}</p>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              {t('usageStats.error.retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Time alone for a read made today, date and time otherwise. */
function formatUpdatedAt(timestamp: number, preference: TimeFormatPreference): string {
  if (isSameLocalDay(timestamp, Date.now())) return formatTimeForPreference(timestamp, preference);
  return formatDateTimeForPreference(timestamp, preference, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

type Formats = {
  integer: Intl.NumberFormat;
  compact: Intl.NumberFormat;
  cost: Intl.NumberFormat;
  day: Intl.DateTimeFormat;
};

function UsageReport({ stats, formats }: { stats: UsageStats; formats: Formats }): React.ReactNode {
  const { t } = useI18n();
  const cache = stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile
          label={t('usageStats.metric.sessions')}
          value={formats.integer.format(stats.sessions)}
          hint={t('usageStats.metric.subagents', { count: formats.integer.format(stats.subagents) })}
        />
        <StatTile label={t('usageStats.metric.prompts')} value={formats.integer.format(stats.prompts)} />
        <StatTile
          label={t('usageStats.metric.tokens')}
          value={formats.compact.format(stats.tokens.total)}
          hint={t('usageStats.metric.tokensBreakdown', {
            input: formats.compact.format(stats.tokens.input),
            output: formats.compact.format(stats.tokens.output + stats.tokens.reasoning),
            cache: formats.compact.format(cache),
          })}
        />
        <StatTile label={t('usageStats.metric.cost')} value={formats.cost.format(stats.cost)} />
        <StatTile label={t('usageStats.metric.activeDays')} value={formats.integer.format(stats.activeDays)} />
        <StatTile label={t('usageStats.metric.streak')} value={formats.integer.format(stats.streak)} />
      </div>

      <ActivityChart stats={stats} formats={formats} />

      <ModelUsage models={stats.models} formats={formats} />
    </>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }): React.ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2.5">
      <span className="truncate typography-micro text-muted-foreground">{label}</span>
      <span className="truncate text-xl font-semibold tabular-nums text-foreground">{value}</span>
      {hint ? <span className="truncate typography-micro text-muted-foreground/80" title={hint}>{hint}</span> : null}
    </div>
  );
}

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }): React.ReactNode {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
        {caption ? <span className="truncate typography-micro text-muted-foreground">{caption}</span> : null}
      </div>
      {children}
    </section>
  );
}

const parseDay = (key: string): Date => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
};

function ActivityChart({ stats, formats }: { stats: UsageStats; formats: Formats }): React.ReactNode {
  const { t } = useI18n();
  const series = React.useMemo(() => buildActivitySeries(stats), [stats]);
  // Bar under the pointer or the keyboard cursor; null shows no tooltip.
  const [active, setActive] = React.useState<number | null>(null);
  const weekly = series.unit === 'week';
  const title = t(weekly ? 'usageStats.activity.titleWeekly' : 'usageStats.activity.titleDaily');
  const labelFor = (bar: ActivityBar) =>
    bar.start === bar.end
      ? formats.day.format(parseDay(bar.start))
      : `${formats.day.format(parseDay(bar.start))} – ${formats.day.format(parseDay(bar.end))}`;
  const describe = (bar: ActivityBar) => t('usageStats.activity.barLabel', { date: labelFor(bar), count: formats.integer.format(bar.steps) });
  const count = series.bars.length;
  const activeBar = active !== null && active < count ? series.bars[active] : null;
  const first = series.bars[0];
  const last = series.bars[count - 1];

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = active ?? count - 1;
    const next = event.key === 'ArrowLeft' ? Math.max(0, current - 1)
      : event.key === 'ArrowRight' ? Math.min(count - 1, current + 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? count - 1
            : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <Section title={title} caption={t(weekly ? 'usageStats.activity.captionWeekly' : 'usageStats.activity.captionDaily')}>
      <div className="rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 pb-2 pt-3">
        <div
          className="relative flex h-32 items-end gap-px rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
          role="group"
          tabIndex={0}
          aria-label={title}
          onKeyDown={handleKeyDown}
          onFocus={() => setActive((value) => value ?? (count > 0 ? count - 1 : null))}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          {series.bars.map((bar, index) => {
            const height = series.max > 0 ? Math.max(bar.steps > 0 ? 4 : 0, (bar.steps / series.max) * 100) : 0;
            const dimmed = activeBar !== null && index !== active;
            return (
              <div key={bar.start} className="flex h-full min-w-0 flex-1 items-end" onPointerEnter={() => setActive(index)}>
                <div
                  className={cn(
                    'w-full rounded-t-[2px] transition-opacity duration-100',
                    bar.steps > 0 ? 'bg-chart-1' : 'bg-border/60',
                    dimmed && 'opacity-40',
                  )}
                  style={{ height: bar.steps > 0 ? `${height}%` : '1px' }}
                />
              </div>
            );
          })}
          {activeBar && active !== null ? (
            <div
              className="oc-glass-tooltip pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-56 rounded-xl border border-border/60 px-3 py-1.5 typography-meta text-[var(--surface-elevated-foreground)]"
              style={{
                left: `${((active + 0.5) / count) * 100}%`,
                transform: `translateX(${active < count / 3 ? '-15%' : active > (count * 2) / 3 ? '-85%' : '-50%'})`,
              }}
              aria-live="polite"
            >
              {describe(activeBar)}
            </div>
          ) : null}
        </div>
        {first && last ? (
          <div className="mt-1.5 flex justify-between gap-2 typography-micro text-muted-foreground">
            <span>{formats.day.format(parseDay(first.start))}</span>
            <span>{formats.day.format(parseDay(last.end))}</span>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ModelUsage({ models, formats }: { models: UsageModel[]; formats: Formats }): React.ReactNode {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const maxTokens = models.reduce((max, model) => Math.max(max, model.tokens.total), 0);

  return (
    <Section title={t('usageStats.models.title')}>
      {models.length === 0 ? (
        <p className="typography-micro text-muted-foreground">{t('usageStats.models.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {models.map((model) => {
            const provider = providers.find((entry) => entry.id === model.providerID);
            const providerName = provider?.name || model.providerID;
            const name = getProviderModelDisplayName(provider, model.modelID) || model.modelID;
            const share = maxTokens > 0 ? (model.tokens.total / maxTokens) * 100 : 0;
            return (
              <li key={`${model.providerID}/${model.modelID}#${model.variant ?? ''}`} className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderLogo providerId={model.providerID} alt={providerName} className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate" title={`${providerName} · ${model.providerID}/${model.modelID}`}>
                    <span className="truncate typography-ui-label text-foreground">{name}</span>
                    {model.variant ? <span className="shrink-0 typography-micro text-muted-foreground">{model.variant}</span> : null}
                    {/* Phones keep the row for the model name; the logo names the provider there. */}
                    <span className="hidden shrink-0 typography-micro text-muted-foreground/80 sm:inline">{providerName}</span>
                  </span>
                  <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
                    {`${formats.compact.format(model.tokens.total)} · ${formats.cost.format(model.cost)}`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/50">
                  <div className="h-full rounded-full bg-chart-1" style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
