import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { QuotaProviderLogo } from '@/components/usage/QuotaProviderLogo';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { compactQuotaValueLabel, formatQuotaResetLabel, formatQuotaResetShort, formatQuotaWindowValueLabel, isExtensionQuotaProviderId } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { useUsageProviderGroups } from '@/components/usage/usageGroups';
import { UsageGiftResetButton } from '@/components/usage/UsageGiftResetButton';
import { useConfigStore } from '@/stores/useConfigStore';
import { pickUsageHeadline } from './usageHeadline';
import { WorkStatusRow, WorkStatusCollapsibleSection, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { usageValueTone } from './usageValueTone';



export const WorkStatusUsageSection: React.FC<{ visible?: boolean }> = ({ visible = true }) => {
  const { t } = useI18n();
  const groups = useUsageProviderGroups();
  const displayMode = useQuotaStore((state) => state.displayMode);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const loadedRuntimeKey = useQuotaStore((state) => state.loadedRuntimeKey);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const fetchQuotas = useQuotaStore((state) => state.fetchQuotas);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);

  useQuotaAutoRefresh(visible && (groups.length > 0 || loadedRuntimeKey === null));

  React.useEffect(() => {
    if (groups.length === 0) return;
    preloadProviderLogos(groups.map((group) => group.providerId).filter((id) => !isExtensionQuotaProviderId(id)));
  }, [groups]);

  useReportWorkStatusPresence('usage', groups.length > 0);

  if (groups.length === 0) return null;

  const modeLabel = displayMode === 'remaining'
    ? t('header.services.remaining')
    : t('header.services.used');

  const headline = pickUsageHeadline(groups, currentProviderId);
  const headlineMetric = headline
    ? formatQuotaWindowValueLabel(
      headline.row.window,
      displayMode === 'remaining' ? headline.row.window.remainingPercent : headline.row.window.usedPercent,
      t,
      displayMode,
    )
    : null;

  return (
    <WorkStatusCollapsibleSection
      id="usage"
      title={t('chat.workStatus.section.usage')}
      icon="timer"
      summary={(
        <span className="flex min-w-0 items-center justify-end gap-1.5">
          {headline && headlineMetric && headlineMetric !== '-' ? (
            <>
              <span className="min-w-0 shrink-[9999] truncate">{headline.row.label}</span>
              <span className="min-w-0 truncate">
                <WorkStatusValue tone={usageValueTone(headline.row.window) === 'muted' ? 'default' : usageValueTone(headline.row.window)}>{compactQuotaValueLabel(headlineMetric)}</WorkStatusValue>
              </span>
            </>
          ) : modeLabel}
        </span>
      )}
      titleAction={(
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                onClick={() => void fetchQuotas(dropdownProviderIds)}
                aria-label={t('settings.usage.sidebar.actions.refreshAria')}
                disabled={isLoading}
              >
                <Icon name="refresh" className={cn('size-[13px]', isLoading && 'animate-spin')} />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('settings.usage.sidebar.actions.refreshTitle')}</TooltipContent>
        </Tooltip>
      )}
    >
      {groups.map((group, groupIndex) => (
        <React.Fragment key={group.providerId}>
          <WorkStatusRow
            className={groupIndex > 0 ? 'mt-2' : undefined}
            leading={<QuotaProviderLogo providerId={group.providerId} className="size-[13px] shrink-0 text-muted-foreground" tint />}
            label={group.status && group.rows.length === 0 ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-foreground">{group.providerName}</span>
                <span dir="auto" className="ms-auto max-w-[calc(100%-2rem)] shrink-0 truncate">{group.status}</span>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-foreground">{group.providerName}</span>
                {group.accountLabel ? (
                  <span className="min-w-0 truncate" title={group.accountLabel}>{group.accountLabel}</span>
                ) : null}
              </span>
            )}
            tooltip={group.status && group.rows.length === 0 ? group.status : undefined}
          />
          {group.rows.map((row) => {
            const displayPercent = displayMode === 'remaining'
              ? row.window.remainingPercent
              : row.window.usedPercent;
            const metricLabel = formatQuotaWindowValueLabel(row.window, displayPercent, t, displayMode);
            const shownMetric = compactQuotaValueLabel(metricLabel);
            const resetFallback = row.window.resetAfterFormatted ?? row.window.resetAtFormatted;
            const { providerId } = group;
            const { resetAt } = row.window;
            const resetLabel = formatQuotaResetShort(resetAt, resetFallback, timeFormatPreference, { providerId });
            const resetFull = formatQuotaResetLabel(resetAt, resetFallback, timeFormatPreference, providerId);
            const rowLabel = row.subtitle ? `${row.subtitle} · ${row.label}` : row.label;
            const tooltipLines = [
              shownMetric !== metricLabel ? `${rowLabel}: ${metricLabel}` : null,
              resetFull && resetFull !== resetLabel ? resetFull : null,
            ].filter((line): line is string => line !== null);
            return (
              <WorkStatusRow
                key={`${group.providerId}-${row.key}`}
                leading={<span aria-hidden className="size-[13px] shrink-0" />}
                muted
                label={(
                  <span className="inline-flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">{rowLabel}</span>
                    {resetLabel ? (
                      <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{resetLabel}</span>
                    ) : null}
                  </span>
                )}
                tooltip={tooltipLines.length > 0 ? (
                  <span className="flex flex-col gap-0.5">{tooltipLines.map((line) => <span key={line}>{line}</span>)}</span>
                ) : undefined}
                value={metricLabel === '-' ? undefined : (
                  <span className="inline-flex items-center gap-1">
                    <UsageGiftResetButton window={row.window} providerId={group.providerId} />
                    <WorkStatusValue tone={usageValueTone(row.window)}>{shownMetric}</WorkStatusValue>
                  </span>
                )}
              />
            );
          })}
        </React.Fragment>
      ))}
    </WorkStatusCollapsibleSection>
  );
};
