import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useSessionMessageRecords, useSessionStatus } from '@/sync/sync-context';
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

export const WorkStatusTelemetrySection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();

  const storedExpanded = useUIStore(
    React.useCallback((state) => state.workStatusExpandedSections['telemetry'], []),
  );
  const expanded = storedExpanded ?? true;

  const sessionStatus = useSessionStatus(sessionId ?? '', directory ?? undefined);
  const isIdle = !sessionStatus || sessionStatus.type === 'idle';

  const records = useSessionMessageRecords(
    sessionId ?? '',
    directory ?? undefined,
    { enabled: expanded },
  );

  const lastStatsRef = React.useRef<CompletedTurnStats | null>(null);
  const lastSessionIdRef = React.useRef<string | null>(sessionId);

  if (lastSessionIdRef.current !== sessionId) {
    lastSessionIdRef.current = sessionId;
    lastStatsRef.current = null;
  }

  const stats = React.useMemo(() => {
    if (!sessionId) return null;
    if (isIdle) {
      if (!records || records.length === 0) return null;
      const computed = getLatestCompletedTurnStats(records);
      lastStatsRef.current = computed;
      return computed;
    }
    return lastStatsRef.current;
  }, [sessionId, records, isIdle]);

  useReportWorkStatusPresence('telemetry', stats !== null);

  if (!sessionId || !stats) return null;

  const {
    stepsCount,
    totalLlmDurationMs,
    totalToolDurationMs,
    avgTtftMs,
    tokensPerSecond,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalGeneratedTokens,
    cacheHitPercent,
    cost,
  } = stats;

  const headerSummary = tokensPerSecond !== null
    ? `${formatThroughputRate(tokensPerSecond)} · ${formatTelemetryDuration(totalLlmDurationMs)}`
    : formatTelemetryDuration(totalLlmDurationMs);

  const tokensOutLabel = reasoningTokens > 0
    ? `${formatTelemetryTokens(totalGeneratedTokens)} out+reasoning`
    : `${formatTelemetryTokens(outputTokens)} out`;

  return (
    <WorkStatusCollapsibleSection
      id="telemetry"
      title={t('chat.workStatus.section.telemetry')}
      icon="bar-chart-2"
      summary={headerSummary}
      defaultExpanded
    >
      {tokensPerSecond !== null ? (
        <WorkStatusRow
          icon="timer"
          label={t('chat.workStatus.telemetry.speed')}
          value={<WorkStatusValue tone="success">{formatThroughputRate(tokensPerSecond)}</WorkStatusValue>}
        />
      ) : null}

      <WorkStatusRow
        icon="time"
        label={t('chat.workStatus.telemetry.llmDuration')}
        value={<WorkStatusValue>{formatTelemetryDuration(totalLlmDurationMs)}</WorkStatusValue>}
      />

      {totalToolDurationMs > 0 ? (
        <WorkStatusRow
          icon="command"
          label={t('chat.workStatus.telemetry.toolDuration')}
          value={<WorkStatusValue>{formatTelemetryDuration(totalToolDurationMs)}</WorkStatusValue>}
        />
      ) : null}

      {avgTtftMs !== null ? (
        <WorkStatusRow
          icon="timer"
          label={t('chat.workStatus.telemetry.ttft')}
          value={<WorkStatusValue>{formatTelemetryDuration(avgTtftMs)}</WorkStatusValue>}
        />
      ) : null}

      {stepsCount > 1 ? (
        <WorkStatusRow
          icon="checkbox-circle"
          label={t('chat.workStatus.telemetry.steps')}
          value={<WorkStatusValue>{stepsCount}</WorkStatusValue>}
        />
      ) : null}

      {inputTokens > 0 || totalGeneratedTokens > 0 ? (
        <WorkStatusRow
          icon="file-code"
          label={t('chat.workStatus.telemetry.tokens')}
          value={(
            <WorkStatusValue>
              {`${formatTelemetryTokens(inputTokens)} in · ${tokensOutLabel}`}
            </WorkStatusValue>
          )}
        />
      ) : null}

      {cacheHitPercent !== null ? (
        <WorkStatusRow
          icon="donut-chart"
          label={t('chat.workStatus.telemetry.cacheHit')}
          value={(
            <WorkStatusValue tone={cacheHitPercent >= 50 ? 'success' : 'default'}>
              {`${cacheHitPercent}%`}
            </WorkStatusValue>
          )}
        />
      ) : null}

      {cost !== null ? (
        <WorkStatusRow
          icon="briefcase"
          label={t('chat.workStatus.telemetry.cost')}
          value={<WorkStatusValue tone="muted">{`$${cost.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`}</WorkStatusValue>}
        />
      ) : null}
    </WorkStatusCollapsibleSection>
  );
};
