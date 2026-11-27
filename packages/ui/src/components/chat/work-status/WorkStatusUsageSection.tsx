import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { QuotaProviderLogo } from '@/components/usage/QuotaProviderLogo';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { useQuotaRetryElapsed, useWorkStatusAccounts } from '@/hooks/useWorkStatusAccounts';
import { compactQuotaValueLabel, formatQuotaResetLabel, formatQuotaResetShort, formatQuotaWindowValueLabel, isExtensionQuotaProviderId } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaProviders, useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { usageRows, useUsageProviderGroups, type UsageLimitRow, type UsageProviderGroup } from '@/components/usage/usageGroups';
import { UsageGiftResetButton } from '@/components/usage/UsageGiftResetButton';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import type { QuotaProviderId } from '@/types';
import type { QuotaAccountUsage } from '@/lib/quota/fetchQuota';
import { pickUsageHeadline } from './usageHeadline';
import { WorkStatusRow, WorkStatusCollapsibleSection, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { usageValueTone } from './usageValueTone';

const READING_MAX_AGE_MS = 3 * 60 * 1000;

export const WorkStatusUsageSection: React.FC<{ visible?: boolean }> = ({ visible = true }) => {
  const { t } = useI18n();
  const groups = useUsageProviderGroups();
  const displayMode = useQuotaStore((state) => state.displayMode);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const loadedRuntimeKey = useQuotaStore((state) => state.loadedRuntimeKey);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const fetchQuotas = useQuotaStore((state) => state.fetchQuotas);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const usageExpanded = useUIStore((state) => state.workStatusExpandedSections.usage);
  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);
  const isVSCode = useIsVSCodeRuntime();
  const [accountMode, setAccountMode] = React.useState(false);
  const requestedProviders = dropdownProviderIds.filter((id) => !isExtensionQuotaProviderId(id)).join(',');
  const hasAccountMode = !isVSCode && requestedProviders !== '';
  const showAccounts = hasAccountMode && accountMode;
  const canOpenParkedAccounts = hasAccountMode && loadedRuntimeKey !== null;
  const toggleAccounts = () => {
    setAccountMode(!showAccounts);
    if (!showAccounts) setSectionExpanded('usage', true);
  };
  const { snapshot, refresh } = useWorkStatusAccounts(visible && showAccounts && usageExpanded === true, requestedProviders);
  const refreshing = showAccounts ? snapshot?.status === 'loading' : isLoading;

  useQuotaAutoRefresh(visible && !showAccounts && (groups.length > 0 || loadedRuntimeKey === null));

  React.useEffect(() => {
    if (groups.length === 0) return;
    preloadProviderLogos(groups.map((group) => group.providerId).filter((id) => !isExtensionQuotaProviderId(id)));
  }, [groups]);

  useReportWorkStatusPresence('usage', showAccounts || canOpenParkedAccounts || groups.length > 0);

  if (!showAccounts && groups.length === 0) {
    return canOpenParkedAccounts ? (
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={toggleAccounts}>
        <Icon name="team" className="size-[13px]" />
        {t('chat.workStatus.usageAccounts.toggle')}
      </Button>
    ) : null;
  }

  const modeLabel = displayMode === 'remaining'
    ? t('header.services.remaining')
    : t('header.services.used');

  const headline = showAccounts ? null : pickUsageHeadline(groups, currentProviderId);
  const headlineMetric = headline
    ? formatQuotaWindowValueLabel(
      headline.row.window,
      displayMode === 'remaining' ? headline.row.window.remainingPercent : headline.row.window.usedPercent,
      t,
    )
    : null;

  return (
    <WorkStatusCollapsibleSection
      id="usage"
      title={t('chat.workStatus.section.usage')}
      icon="timer"
      summary={(
        <span className="inline-flex items-center gap-1.5">
          {headline && headlineMetric && headlineMetric !== '-' ? (
            <>
              <span className="truncate">{headline.row.label}</span>
              <WorkStatusValue tone={usageValueTone(headline.row.window) === 'muted' ? 'default' : usageValueTone(headline.row.window)}>{headlineMetric}</WorkStatusValue>
            </>
          ) : modeLabel}
        </span>
      )}
      action={<>
        {hasAccountMode ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground"
                aria-label={t('chat.workStatus.usageAccounts.toggle')}
                aria-pressed={showAccounts}
                onClick={toggleAccounts}
              >
                <Icon name="team" className="size-[13px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('chat.workStatus.usageAccounts.toggle')}</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                onClick={showAccounts ? refresh : () => void fetchQuotas(dropdownProviderIds)}
                aria-label={t('settings.usage.sidebar.actions.refreshAria')}
                disabled={refreshing || (showAccounts && !usageExpanded)}
              >
                <Icon name="refresh" className={cn('size-[13px]', refreshing && 'animate-spin')} />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('settings.usage.sidebar.actions.refreshTitle')}</TooltipContent>
        </Tooltip>
      </>}
    >
      {showAccounts && (!snapshot || snapshot.status !== 'ready') ? (
        <WorkStatusRow
          muted
          label={snapshot?.status === 'error'
            ? t('chat.workStatus.usageAccounts.refreshError')
            : t('chat.workStatus.usageAccounts.loading')}
        />
      ) : null}
      {showAccounts && snapshot?.accounts ? (
        <AccountGroups accounts={snapshot.accounts} displayMode={displayMode} failed={snapshot.status === 'error'} />
      ) : null}
      {showAccounts && snapshot?.status === 'ready' && !snapshot.accounts?.length ? (
        <WorkStatusRow muted label={t('chat.workStatus.usageAccounts.empty')} />
      ) : null}
      {!showAccounts && groups.map((group, groupIndex) => (
        <React.Fragment key={group.providerId}>
          <CompactProviderRow group={group} separated={groupIndex > 0} />
          <UsageRows providerId={group.providerId} rows={group.rows} displayMode={displayMode} allowGiftReset />
        </React.Fragment>
      ))}
    </WorkStatusCollapsibleSection>
  );
};

type DisplayMode = 'usage' | 'remaining';

const accountSourceNames = {
  'claude-code': 'Claude Code',
  'claude-env': 'CLAUDE_CODE_OAUTH_TOKEN',
  'codex-cli': 'Codex CLI',
};

function CompactProviderRow({ group, separated }: { group: UsageProviderGroup; separated: boolean }) {
  const { t } = useI18n();
  const status = group.rows.length === 0 ? group.status : null;
  const source = group.accountSource ? accountSourceNames[group.accountSource] : null;
  const detail = group.accountLabel ?? source;
  const sourceHint = source && t(group.accountLabel
    ? 'chat.workStatus.usageAccounts.readFrom'
    : 'chat.workStatus.usageAccounts.unknownSourceAccount', { source });
  return (
    <WorkStatusRow
      className={separated ? 'mt-2' : undefined}
      leading={<QuotaProviderLogo providerId={group.providerId} className="size-[13px] shrink-0 text-muted-foreground" tint />}
      label={(
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-foreground">{group.providerName}</span>
          {status ? (
            <span dir="auto" className="ms-auto max-w-[calc(100%-2rem)] shrink-0 truncate">{status}</span>
          ) : detail ? (
            <>
              <span aria-hidden>·</span>
              <span dir="auto" className="min-w-0 truncate">{detail}</span>
            </>
          ) : null}
        </span>
      )}
      tooltip={status ?? (sourceHint ? (
        <span className="flex flex-col">
          {group.accountLabel ? <span dir="auto">{group.accountLabel}</span> : null}
          <span>{sourceHint}</span>
        </span>
      ) : group.accountLabel ? <span dir="auto">{group.accountLabel}</span> : undefined)}
    />
  );
}

function openProviderAccounts(integrationId: string | undefined) {
  const ui = useUIStore.getState();
  ui.setSettingsProvidersOpenRequested(integrationId ?? null);
  ui.openSettingsAt('providers', integrationId ? 'providers.auth' : null);
}

function CooldownHint({ retryAt }: { retryAt: number }) {
  const { t } = useI18n();
  const elapsed = useQuotaRetryElapsed(retryAt);
  return elapsed ? t('chat.workStatus.usageAccounts.rateLimited')
    : t('chat.workStatus.usageAccounts.cooldown', { time: new Date(retryAt).toLocaleString(getCurrentIntlLocale()) });
}

function AccountGroups({ accounts, displayMode, failed }: {
  accounts: QuotaAccountUsage[];
  displayMode: DisplayMode;
  failed: boolean;
}) {
  const { t } = useI18n();
  const now = useMinuteTickerNow(accounts.some(({ status, reading }) => status === 'fresh' && reading !== null));
  const locale = getCurrentIntlLocale();
  const enterpriseLocked = useEnterpriseMode();
  const reconnectLabel = t(enterpriseLocked ? 'settings.providers.accounts.title' : 'chat.workStatus.usageAccounts.reconnect');
  const providers = useQuotaProviders();
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  return providers.map((provider) => {
    const stored = accounts.filter(({ providerId }) => providerId === provider.id);
    if (!stored.length) return null;
    return (
      <React.Fragment key={provider.id}>
        <WorkStatusRow
          className="mt-2"
          leading={<QuotaProviderLogo providerId={provider.id} className="size-[13px] shrink-0 text-muted-foreground" tint />}
          label={<span className="text-foreground">{provider.name}</span>}
        />
        {stored.map(({ id, integrationId, label, status, reading, retryAt }) => {
          const rows = usageRows(provider.id, reading?.usage, selectedModels[provider.id] ?? []);
          const stale = reading !== null && (status !== 'fresh' || failed || now - reading.fetchedAt >= READING_MAX_AGE_MS);
          const message = status === 'expired' ? t('chat.workStatus.usageAccounts.expired')
            : status === 'unsupported' ? t('chat.workStatus.usageAccounts.unsupported')
              : status === 'missing' ? t('chat.workStatus.usageAccounts.missing')
                 : status === 'transient' ? t('chat.workStatus.usageAccounts.refreshError')
                   : status === 'cooldown' ? t('chat.workStatus.usageAccounts.rateLimited')
                     : rows.length === 0 ? t('header.services.noRateLimitsReported') : null;
          const sampledAt = reading && new Date(reading.fetchedAt).toLocaleString(locale);
          const freshnessReason = status === 'expired' ? message
            : status === 'cooldown'
              ? retryAt === undefined ? message : <CooldownHint retryAt={retryAt} />
              : failed || status === 'transient' ? t('chat.workStatus.usageAccounts.refreshError') : null;
          return (
            <React.Fragment key={id}>
              <WorkStatusRow
                leading={<span aria-hidden className="size-[13px] shrink-0" />}
                label={(
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-foreground" dir="auto">{label}</span>
                    {reading?.planLabel ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="max-w-[40%] shrink-0 truncate text-muted-foreground" dir="auto">{reading.planLabel}</span>
                      </>
                    ) : null}
                  </span>
                )}
                value={stale ? <WorkStatusValue tone="warning">{t('chat.workStatus.usageAccounts.stale')}</WorkStatusValue> : undefined}
                tooltip={sampledAt || freshnessReason ? (
                  <span className="flex flex-col gap-0.5">
                    {sampledAt ? <span>{t('chat.workStatus.usageAccounts.sampledAt', { time: sampledAt })}</span> : null}
                    {freshnessReason ? <span>{freshnessReason}</span> : null}
                  </span>
                ) : undefined}
              />
              {message ? (
                <WorkStatusRow
                  leading={<span aria-hidden className="size-[13px] shrink-0" />}
                  label={status === 'expired' ? (
                    <>
                      {message}{' '}
                      <span className="underline underline-offset-2">{reconnectLabel}</span>
                    </>
                  ) : message}
                  onClick={status === 'expired' ? () => openProviderAccounts(integrationId) : undefined}
                  ariaLabel={status === 'expired' ? `${message} ${reconnectLabel} · ${provider.name} · ${label}` : undefined}
                  tooltip={status === 'expired' || freshnessReason ? undefined : message}
                  muted
                />
              ) : null}
              <UsageRows providerId={provider.id} rows={rows} displayMode={displayMode} />
            </React.Fragment>
          );
        })}
      </React.Fragment>
    );
  });
}

function UsageRows({ providerId, rows, displayMode, allowGiftReset = false }: {
  providerId: QuotaProviderId;
  rows: UsageLimitRow[];
  displayMode: DisplayMode;
  allowGiftReset?: boolean;
}) {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  return rows.map((row) => {
    const displayPercent = displayMode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
    const metricLabel = formatQuotaWindowValueLabel(row.window, displayPercent, t);
    const shownMetric = compactQuotaValueLabel(metricLabel);
    const resetFallback = row.window.resetAfterFormatted ?? row.window.resetAtFormatted;
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
        key={row.key}
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
            {allowGiftReset ? <UsageGiftResetButton window={row.window} providerId={providerId} /> : null}
            <WorkStatusValue tone={usageValueTone(row.window)}>{shownMetric}</WorkStatusValue>
          </span>
        )}
      />
    );
  });
}
