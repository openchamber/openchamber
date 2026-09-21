import React from 'react';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDirectorySync, useSessionMessageRecords, useSyncDirectory, useSyncRuntime } from '@/sync/sync-context';
import { normalizePath } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';
import {
  WorkStatusCollapsibleSection,
  WorkStatusRow,
  WorkStatusValue,
} from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import {
  formatTelemetryDuration,
  formatTelemetryTokens,
  formatThroughputRate,
  getLatestCompletedTurnStats,
  type CompletedTurnStats,
} from './telemetry';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/** One hover/focus target covers both the label and its value. */
const TelemetryRow: React.FC<{ label: string; description: string; value: React.ReactNode }> = ({ label, description, value }) => (
  <Tooltip delayDuration={750}>
    <TooltipTrigger asChild>
      <div tabIndex={0} className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <WorkStatusRow label={label} value={value} />
      </div>
    </TooltipTrigger>
    <TooltipContent side="left" sideOffset={8} className="max-w-[min(320px,calc(100vw-24px))] whitespace-normal break-words text-left">
      <p className="font-medium">{label}</p>
      <p>{description}</p>
    </TooltipContent>
  </Tooltip>
);

export const WorkStatusTelemetrySection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const expanded = useUIStore(
    React.useCallback((state) => state.workStatusExpandedSections['telemetry'] ?? true, []),
  );
  const { runtimeKey } = useSyncRuntime();
  const syncDirectory = useSyncDirectory();
  const scope = JSON.stringify([runtimeKey, normalizePath(directory ?? syncDirectory), sessionId]);
  const status = useDirectorySync(
    React.useCallback((state) => sessionId
      ? state.session_status[sessionId]?.type ?? (state.sessionStatusReady ? 'idle' : 'unknown')
      : 'unknown', [sessionId]),
    directory ?? undefined,
  );
  const eligibleForStats = Boolean(sessionId && expanded && status === 'idle');

  const records = useSessionMessageRecords(
    sessionId ?? '',
    directory ?? undefined,
    { enabled: eligibleForStats },
  );

  const computed = React.useMemo(() => {
    if (!eligibleForStats) return null;
    return getLatestCompletedTurnStats(records);
  }, [eligibleForStats, records]);

  // Retain only one committed result, never message history or a global ID cache.
  const [retained, setRetained] = React.useState<{ scope: string; stats: CompletedTurnStats | null } | null>(null);
  React.useEffect(() => {
    if (eligibleForStats) {
      setRetained({ scope, stats: computed });
    } else {
      setRetained((previous) => previous?.scope === scope && status !== 'unknown' ? previous : null);
    }
  }, [scope, status, eligibleForStats, computed]);
  const stats = eligibleForStats ? computed : status !== 'unknown' && retained?.scope === scope ? retained.stats : null;
  const summary = stats && stats.responseTokensPerSecond !== null
    ? formatThroughputRate(stats.responseTokensPerSecond)
    : undefined;

  useReportWorkStatusPresence('telemetry', Boolean(sessionId));

  if (!sessionId) return null;

  return (
    <WorkStatusCollapsibleSection
      id="telemetry"
      title={t('chat.workStatus.section.telemetry')}
      icon="bar-chart-2"
      summary={summary}
      defaultExpanded
    >
      {stats ? (
        <>
          {stats.responseTokensPerSecond !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.responseSpeed')}
              description={t('chat.workStatus.telemetry.responseSpeedDescription')}
              value={<WorkStatusValue>{formatThroughputRate(stats.responseTokensPerSecond)}</WorkStatusValue>}
            />
          ) : null}
          {stats.tokensPerSecond !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.speed')}
              description={t('chat.workStatus.telemetry.speedDescription')}
              value={<WorkStatusValue>{formatThroughputRate(stats.tokensPerSecond)}</WorkStatusValue>}
            />
          ) : null}

          {stats.totalLlmDurationMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.llmDuration')}
              description={t('chat.workStatus.telemetry.llmDurationDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.totalLlmDurationMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.totalToolDurationMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.toolDuration')}
              description={t('chat.workStatus.telemetry.toolDurationDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.totalToolDurationMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.avgTtftMs !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.ttft')}
              description={t('chat.workStatus.telemetry.ttftDescription')}
              value={<WorkStatusValue>{formatTelemetryDuration(stats.avgTtftMs)}</WorkStatusValue>}
            />
          ) : null}

          {stats.stepsCount > 1 ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.steps')}
              description={t('chat.workStatus.telemetry.stepsDescription')}
              value={<WorkStatusValue>{stats.stepsCount}</WorkStatusValue>}
            />
          ) : null}

          {stats.inputTokens !== null && stats.outputTokens !== null && stats.reasoningTokens !== null && stats.totalGeneratedTokens !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.tokens')}
              description={t('chat.workStatus.telemetry.tokensDescription', {
                input: stats.inputTokens.toLocaleString(getCurrentIntlLocale()),
                output: stats.outputTokens.toLocaleString(getCurrentIntlLocale()),
                reasoning: stats.reasoningTokens.toLocaleString(getCurrentIntlLocale()),
              })}
              value={(
                <WorkStatusValue>
                  {t('chat.workStatus.telemetry.tokens.inOut', {
                    input: formatTelemetryTokens(stats.inputTokens),
                    output: formatTelemetryTokens(stats.totalGeneratedTokens),
                  })}
                </WorkStatusValue>
              )}
            />
          ) : null}

          {stats.cacheHitPercent !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.cacheHit')}
              description={t('chat.workStatus.telemetry.cacheHitDescription')}
              value={(
                <WorkStatusValue tone={stats.cacheHitPercent >= 50 ? 'success' : 'default'}>
                  {`${stats.cacheHitPercent}%`}
                </WorkStatusValue>
              )}
            />
          ) : null}

          {stats.cost !== null ? (
            <TelemetryRow
              label={t('chat.workStatus.telemetry.cost')}
              description={t('chat.workStatus.telemetry.costDescription')}
              value={<WorkStatusValue tone="muted">{`$${stats.cost.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`}</WorkStatusValue>}
            />
          ) : null}
        </>
      ) : null}
    </WorkStatusCollapsibleSection>
  );
};
