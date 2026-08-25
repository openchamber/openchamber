import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/lib/i18n';
import type { IconName } from '@/components/icon/icons';
import type { ForgeCheckState, ForgeChecksCapability, ForgeChecksSummary } from '@/lib/forge/types';

interface ForgeChecksSectionProps {
  kind: ForgeChecksCapability;
  summary: ForgeChecksSummary | null;
  loading?: boolean;
  error?: string | null;
}

const stateColor = (state: ForgeCheckState): string => {
  switch (state) {
    case 'success':
      return 'var(--status-success)';
    case 'failure':
      return 'var(--status-error)';
    case 'pending':
      return 'var(--status-warning)';
    default:
      return 'var(--surface-muted-foreground)';
  }
};

const stateIcon = (state: ForgeCheckState): IconName => {
  switch (state) {
    case 'success':
      return 'checkbox-circle';
    case 'failure':
      return 'close-circle';
    case 'pending':
      return 'loader-4';
    case 'cancelled':
      return 'close-circle';
    case 'skipped':
      return 'subtract';
    default:
      return 'question';
  }
};

const formatElapsed = (start?: string, end?: string): string | null => {
  if (!start) return null;
  const startTs = Date.parse(start);
  if (!Number.isFinite(startTs)) return null;
  const endTs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(endTs) || endTs <= startTs) return null;
  const totalMinutes = Math.floor((endTs - startTs) / 60_000);
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

const CheckRunRow: React.FC<{
  name: string;
  state: ForgeCheckState;
  startedAt?: string;
  completedAt?: string;
  description?: string;
  details?: ForgeChecksSummary['checks'][number]['details'];
  expanded: boolean;
  onToggle: () => void;
}> = ({ name, state, startedAt, completedAt, description, details, expanded, onToggle }) => {
  const { t } = useI18n();
  const isPending = state === 'pending';
  const duration = formatElapsed(startedAt, isPending ? undefined : completedAt);
  const hasDetails = Boolean(
    details?.title || details?.summary || details?.text || (details?.annotations?.length ?? 0) > 0,
  );

  return (
    <div className="rounded-md border border-border/40">
      <button
        type="button"
        disabled={!hasDetails}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
        aria-expanded={expanded}
      >
        {isPending ? (
          <Icon name={stateIcon(state)} className="size-4 shrink-0 animate-spin text-[var(--status-warning)]" />
        ) : (
          <Icon name={stateIcon(state)} className="size-4 shrink-0" style={{ color: stateColor(state) }} />
        )}
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{name}</span>
        {duration ? <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">{duration}</span> : null}
        {description ? (
          <span className="hidden min-w-0 flex-1 truncate typography-micro text-muted-foreground sm:block sm:max-w-[40%]">
            {description}
          </span>
        ) : null}
        <span className="shrink-0 typography-micro text-muted-foreground">{t(`forge.checks.state.${state}` as never)}</span>
        {hasDetails ? (
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : null}
      </button>
      {expanded && hasDetails ? (
        <div className="min-w-0 overflow-hidden border-t border-border/40 p-2.5">
          {details?.title ? <div className="typography-micro text-foreground">{details.title}</div> : null}
          {details?.summary ? (
            <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words">{details.summary}</div>
          ) : null}
          {details?.text ? (
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-transparent px-2 py-2 typography-micro text-muted-foreground">
              {details.text}
            </div>
          ) : null}
          {details?.annotations && details.annotations.length > 0 ? (
            <div className="mt-1 space-y-1">
              {details.annotations.map((annotation, idx) => (
                <div
                  key={`${annotation.path ?? 'file'}:${annotation.startLine ?? idx}:${idx}`}
                  className="rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-2 py-2"
                >
                  <div className="typography-micro break-words text-[var(--status-error)]">
                    {annotation.title || annotation.level || 'Issue'}
                    {annotation.path ? ` · ${annotation.path}` : ''}
                    {typeof annotation.startLine === 'number' ? `:${annotation.startLine}` : ''}
                    {typeof annotation.endLine === 'number' && annotation.endLine !== annotation.startLine
                      ? `-${annotation.endLine}`
                      : ''}
                  </div>
                  {annotation.message ? (
                    <div className="typography-micro mt-1 whitespace-pre-wrap break-words text-foreground">
                      {annotation.message}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const CommitStatusStrip: React.FC<{ summary: ForgeChecksSummary }> = ({ summary }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="typography-micro text-muted-foreground">{t('forge.checks.statusStrip')}</div>
      <div className="flex flex-wrap gap-1.5">
        {summary.checks.map((check, idx) => (
          <span
            key={`${check.name}:${idx}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-surface-elevated px-2 py-0.5"
            title={check.description ?? t(`forge.checks.state.${check.state}` as never)}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: stateColor(check.state) }} />
            <span className="typography-micro text-foreground">{check.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/**
 * CI/status summary for a pull request, gated by the provider's checks
 * capability. `'check-runs'` renders an aggregate bar plus expandable per-run
 * rows (title/summary/text + annotations); `'commit-statuses'` renders a strip
 * of status chips. Returns null for `'none'`. Pure presentation.
 */
export const ForgeChecksSection = React.memo<ForgeChecksSectionProps>(function ForgeChecksSection({ kind, summary, loading, error }) {
  const { t } = useI18n();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggle = React.useCallback((key: string) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  if (kind === 'none') return null;

  if (loading) {
    return (
      <div className="flex flex-col gap-2" data-testid="forge-checks-loading">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-3 py-2 typography-micro text-[var(--status-error)]">
        <Icon name="error-warning" className="size-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (!summary || summary.checks.length === 0) {
    return <p className="py-3 text-center typography-micro text-muted-foreground">{t('forge.checks.empty')}</p>;
  }

  if (kind === 'commit-statuses') {
    return <CommitStatusStrip summary={summary} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/40">
          {summary.success > 0 ? (
            <div className="bg-[color:var(--status-success)]" style={{ width: `${(summary.success / summary.total) * 100}%` }} />
          ) : null}
          {summary.failure > 0 ? (
            <div className="bg-[color:var(--status-error)]" style={{ width: `${(summary.failure / summary.total) * 100}%` }} />
          ) : null}
          {summary.pending > 0 ? (
            <div className="bg-[color:var(--status-warning)]" style={{ width: `${(summary.pending / summary.total) * 100}%` }} />
          ) : null}
        </div>
        <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
          {summary.success}/{summary.total} {t('gitView.pr.checks.label')}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {summary.checks.map((check, idx) => {
          const key = `${check.name}:${idx}`;
          return (
            <CheckRunRow
              key={key}
              name={check.name}
              state={check.state}
              startedAt={check.startedAt}
              completedAt={check.completedAt}
              description={check.description}
              details={check.details}
              expanded={expandedKeys.has(key)}
              onToggle={() => toggle(key)}
            />
          );
        })}
      </div>
    </div>
  );
});
