import React from 'react';

import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useActivityTokens } from '@/hooks/useActivityTokens';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import type { UsageStats } from '@/lib/opencode/session-stats';
import { cn } from '@/lib/utils';

import type { Formats } from './usageStatsFormat';
import { Section } from './UsageStatsSection';
import { activityAxisScale, bucketWindowKey, buildActivitySeries, type ActivityBar } from './usageStatsModel';

const parseDay = (key: string): Date => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
};

type ActivityMetric = 'steps' | 'tokens';

const ACTIVITY_METRICS: readonly ActivityMetric[] = ['steps', 'tokens'];

const ACTIVITY_METRIC_LABEL_KEYS = {
  steps: 'usageStats.activity.bySteps',
  tokens: 'usageStats.activity.byTokens',
} as const satisfies Record<ActivityMetric, I18nKey>;

const ACTIVITY_CAPTION_KEYS = {
  day: {
    steps: 'usageStats.activity.captionDaily',
    tokens: 'usageStats.activity.captionDailyTokens',
  },
  week: {
    steps: 'usageStats.activity.captionWeekly',
    tokens: 'usageStats.activity.captionWeeklyTokens',
  },
} as const satisfies Record<'day' | 'week', Record<ActivityMetric, I18nKey>>;

type ActivityBarState = 'loaded' | 'loading' | 'failed';

function activityBarTone(state: ActivityBarState, value: number): string {
  if (state === 'loaded') return value > 0 ? 'bg-chart-1' : 'bg-edge';
  if (state === 'loading') return 'bg-edge';
  return 'border border-dashed border-[color:var(--status-error)] bg-transparent';
}

function activityBarHeight(state: ActivityBarState, value: number, top: number): string {
  if (state !== 'loaded') return '8%';
  if (value <= 0 || top <= 0) return '1px';
  return `${Math.max(4, (value / top) * 100)}%`;
}

function axisLabelTransform(tick: number, top: number): string {
  if (tick === top) return 'translateY(0)';
  if (tick === 0) return 'translateY(-100%)';
  return 'translateY(-50%)';
}

export function ActivityChart({
  stats,
  formats,
  projectDirectory,
}: {
  stats: UsageStats;
  formats: Formats;
  projectDirectory: string | null;
}): React.ReactNode {
  const { t } = useI18n();
  const [metric, setMetric] = React.useState<ActivityMetric>('steps');
  const series = React.useMemo(() => buildActivitySeries(stats), [stats]);
  const buckets = React.useMemo(
    () => series.bars.map((bar) => ({ from: bar.from, to: bar.to })),
    [series],
  );
  const tokenState = useActivityTokens(buckets, projectDirectory, metric === 'tokens');
  const [active, setActive] = React.useState<number | null>(null);
  const weekly = series.unit === 'week';
  const title = t(weekly ? 'usageStats.activity.titleWeekly' : 'usageStats.activity.titleDaily');
  const caption = t(ACTIVITY_CAPTION_KEYS[weekly ? 'week' : 'day'][metric]);
  const labelFor = (bar: ActivityBar) =>
    bar.start === bar.end
      ? formats.day.format(parseDay(bar.start))
      : `${formats.day.format(parseDay(bar.start))} – ${formats.day.format(parseDay(bar.end))}`;
  const tokensOf = (bar: ActivityBar) =>
    tokenState.entries.get(bucketWindowKey(bar.from, bar.to))?.tokens ?? null;
  const barState = (bar: ActivityBar): ActivityBarState => {
    if (metric === 'steps') return 'loaded';
    const entry = tokenState.entries.get(bucketWindowKey(bar.from, bar.to));
    if (entry?.tokens) return 'loaded';
    if (entry?.error) return 'failed';
    return 'loading';
  };
  const valueOf = (bar: ActivityBar): number => (metric === 'steps' ? bar.steps : tokensOf(bar)?.total ?? 0);
  const integerAxis = metric === 'steps';
  const hasValues = integerAxis || tokenState.loaded > 0;
  const max = Math.max(0, ...series.bars.map(valueOf));
  const scale = hasValues ? activityAxisScale(max, integerAxis) : null;
  const axisTop = scale?.top ?? 0;
  const axisTicks = scale?.ticks ?? [];
  const describe = (bar: ActivityBar) => {
    const state = barState(bar);
    if (state === 'loading') return t('usageStats.activity.tokenBarLoading', { date: labelFor(bar) });
    if (state === 'failed') return t('usageStats.activity.tokenBarFailed', { date: labelFor(bar) });
    return metric === 'steps'
      ? t('usageStats.activity.barLabel', { date: labelFor(bar), count: formats.integer.format(bar.steps) })
      : t('usageStats.activity.tokenBarLabel', {
          date: labelFor(bar),
          count: formats.compact.format(tokensOf(bar)?.total ?? 0),
        });
  };
  const count = series.bars.length;
  const activeBar = active !== null && active < count ? series.bars[active] : null;
  const activeTokens = activeBar && metric === 'tokens' ? tokensOf(activeBar) : null;
  const first = series.bars[0];
  const last = series.bars[count - 1];
  const tickLabel = (tick: number) => (integerAxis ? formats.integer.format(tick) : formats.compact.format(tick));
  const axisPercent = (tick: number) => (axisTop > 0 ? (tick / axisTop) * 100 : 0);

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
    <Section
      title={title}
      subtitle={caption}
      actions={
        <SettingsChipGroup
          value={metric}
          onChange={setMetric}
          aria-label={t('usageStats.activity.metric')}
          options={ACTIVITY_METRICS.map((option) => ({ value: option, label: t(ACTIVITY_METRIC_LABEL_KEYS[option]) }))}
        />
      }
    >
      <div dir="ltr" className="rounded-lg border border-edge bg-[var(--surface-elevated)] px-3 pb-2 pt-3">
        <div className="flex h-32 gap-2">
          <div className="relative w-12 shrink-0" aria-hidden="true">
            {axisTicks.map((tick) => (
              <span
                key={tick}
                className="absolute end-0 typography-micro tabular-nums text-muted-foreground"
                style={{
                  top: `${100 - axisPercent(tick)}%`,
                  transform: axisLabelTransform(tick, axisTop),
                }}
              >
                {tickLabel(tick)}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            {axisTicks.length > 0 ? (
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                {axisTicks.map((tick) => (
                  <div
                    key={tick}
                    className={cn('absolute inset-x-0 border-t border-edge', tick === 0 ? 'opacity-70' : 'opacity-40')}
                    style={{ bottom: `${axisPercent(tick)}%` }}
                  />
                ))}
              </div>
            ) : null}
            <div
              className="relative flex h-full items-end gap-px rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              role="group"
              tabIndex={0}
              aria-label={title}
              onKeyDown={handleKeyDown}
              onFocus={() => setActive((value) => value ?? (count > 0 ? count - 1 : null))}
              onBlur={() => setActive(null)}
              onPointerLeave={() => setActive(null)}
            >
              {series.bars.map((bar, index) => {
                const state = barState(bar);
                const value = valueOf(bar);
                const dimmed = activeBar !== null && index !== active;
                return (
                  <div key={bar.start} className="flex h-full min-w-0 flex-1 items-end" onPointerEnter={() => setActive(index)}>
                    <div
                      className={cn(
                        'w-full rounded-t-[2px] transition-opacity duration-100',
                        activityBarTone(state, value),
                        dimmed && 'opacity-40',
                      )}
                      style={{ height: activityBarHeight(state, value, axisTop) }}
                    />
                  </div>
                );
              })}
              {activeBar && active !== null ? (
                <div
                  className="oc-glass-tooltip pointer-events-none absolute bottom-full z-10 mb-1.5 w-max max-w-56 rounded-xl border border-edge px-3 py-1.5 typography-meta text-[var(--surface-elevated-foreground)]"
                  style={{
                    left: `${((active + 0.5) / count) * 100}%`,
                    transform: `translateX(${active < count / 3 ? '-15%' : active > (count * 2) / 3 ? '-85%' : '-50%'})`,
                  }}
                  aria-live="polite"
                >
                  {describe(activeBar)}
                  {activeTokens ? (
                    <span className="mt-0.5 block typography-micro text-muted-foreground">
                      {t('usageStats.metric.tokensBreakdown', {
                        input: formats.compact.format(activeTokens.input),
                        output: formats.compact.format(activeTokens.output + activeTokens.reasoning),
                        cache: formats.compact.format(activeTokens.cacheRead + activeTokens.cacheWrite),
                      })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {first && last ? (
          <div className="mt-1.5 flex gap-2">
            <div className="w-12 shrink-0" aria-hidden="true" />
            <div className="flex flex-1 justify-between gap-2 typography-micro text-muted-foreground">
              <span>{formats.day.format(parseDay(first.start))}</span>
              <span>{formats.day.format(parseDay(last.end))}</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
        {metric === 'tokens' && tokenState.loading ? (
          <span className="flex items-center gap-1.5" role="status">
            <Spinner className="size-3" aria-hidden="true" />
            <span>
              {t('usageStats.activity.tokensProgress', {
                loaded: formats.integer.format(tokenState.loaded),
                total: formats.integer.format(tokenState.total),
              })}
            </span>
          </span>
        ) : metric === 'tokens' && tokenState.failed > 0 ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1" role="alert">
            <span className="text-[var(--status-error)]" title={tokenState.error ?? undefined}>
              {t('usageStats.activity.tokensPartial', {
                failed: formats.integer.format(tokenState.failed),
                total: formats.integer.format(tokenState.total),
              })}
            </span>
            <Button type="button" variant="link" size="xs" onClick={tokenState.retry}>
              {t('usageStats.error.retry')}
            </Button>
          </span>
        ) : null}
      </div>
    </Section>
  );
}
