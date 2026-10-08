import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import type { CIRun } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

import { formatElapsedDuration, isFailedConclusion, type CheckRunExpansion } from './checkRunState';


const CheckRunDetails: React.FC<{
  run: CIRun;
  expansion: CheckRunExpansion;
  formatTimestamp: (value?: string) => string;
}> = ({ run, expansion, formatTimestamp }) => {
  const { t } = useI18n();
  const annotations = run.annotations ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-end gap-3">
        {run.detailsUrl ? (
          <Button variant="outline" size="sm" asChild className="flex-shrink-0">
            <a href={run.detailsUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="external-link" className="size-4" />
              {t('gitView.pr.checks.openRun')}
            </a>
          </Button>
        ) : null}
      </div>

      {run.output?.title ? (
        <div className="typography-micro text-foreground">{run.output.title}</div>
      ) : null}
      {run.output?.summary ? (
        <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words">
          {run.output.summary}
        </div>
      ) : null}
      {run.output?.text ? (
        <div className="rounded border border-border/40 bg-transparent px-2 py-2 typography-micro text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {run.output.text}
        </div>
      ) : null}

      {annotations.length > 0 ? (
        <div className="space-y-1">
          <div className="typography-micro text-muted-foreground">
            {annotations.length > 20
              ? t('gitView.pr.checks.failedAnnotationsShown', { shown: 20, total: annotations.length })
              : t('gitView.pr.checks.failedAnnotations')}
          </div>
          <div className="space-y-1">
            {annotations.slice(0, 20).map((annotation, idx) => (
              <div key={`${annotation.path || 'file'}:${annotation.startLine || idx}:${idx}`} className="rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-2 py-2">
                <div className="typography-micro break-words text-[var(--status-error)]">
                  {annotation.title || annotation.level || 'Issue'}
                  {annotation.path ? ` · ${annotation.path}` : ''}
                  {annotation.startLine !== undefined ? `:${annotation.startLine}` : ''}
                  {annotation.endLine !== undefined && annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ''}
                </div>
                <div className="typography-micro text-foreground whitespace-pre-wrap break-words mt-1">
                  {annotation.message}
                </div>
                {annotation.rawDetails ? (
                  <div className="typography-micro text-muted-foreground whitespace-pre-wrap break-words mt-1">
                    {annotation.rawDetails}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {run.job?.steps && run.job.steps.length > 0 ? (
        <div className="space-y-1">
          <div className="typography-micro text-muted-foreground">{t('gitView.pr.checks.steps')}</div>
          <div className="space-y-1">
            {run.job.steps.map((step, idx) => {
              const stepKey = `${run.id ?? 'run'}:${run.job?.jobId ?? 'job'}:${step.number ?? idx}:${step.name}`;
              if (!isFailedConclusion(step.conclusion)) {
                return (
                  <div key={stepKey} className="typography-micro flex w-full items-center gap-2 rounded px-2 py-1 text-muted-foreground">
                    <span className="truncate">{step.name}</span>
                    {step.conclusion ? <span className="ml-auto flex-shrink-0">{step.conclusion}</span> : null}
                  </div>
                );
              }
              const stepExpanded = expansion.steps.has(stepKey);
              return (
                <Collapsible key={stepKey} open={stepExpanded}>
                  <button
                    type="button"
                    onClick={() => expansion.toggleStep(stepKey)}
                    className="typography-micro flex w-full items-center gap-2 rounded bg-destructive/10 px-2 py-1 text-left text-destructive"
                  >
                    {stepExpanded ? <Icon name="arrow-down-s" className="size-4" /> : <Icon name="arrow-right-s" className="size-4" />}
                    <span className="truncate">{step.name}</span>
                    {step.conclusion ? <span className="ml-auto flex-shrink-0">{step.conclusion}</span> : null}
                  </button>
                  <CollapsibleContent>
                    <div className="ml-6 mt-1 rounded border border-border/40 bg-transparent px-2 py-2 typography-micro text-muted-foreground space-y-1">
                      {step.number !== undefined ? <div>{t('gitView.pr.checks.stepLabel')}: {step.number}</div> : null}
                      {step.status ? <div>{t('gitView.pr.checks.statusLabel')}: {step.status}</div> : null}
                      {step.conclusion ? <div>{t('gitView.pr.checks.conclusionLabel')}: {step.conclusion}</div> : null}
                      {step.startedAt ? <div>{t('gitView.pr.checks.startedLabel')}: {formatTimestamp(step.startedAt)}</div> : null}
                      {step.completedAt ? <div>{t('gitView.pr.checks.completedLabel')}: {formatTimestamp(step.completedAt)}</div> : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/**
 * A change request's check runs, each opening to its output, failed
 * annotations and steps. Shared by the PR panel and the board's checks dialog.
 */
export const CheckRunList: React.FC<{
  runs: CIRun[];
  /** The clock running checks count their time against. */
  now: number;
  expansion: CheckRunExpansion;
  formatTimestamp: (value?: string) => string;
}> = ({ runs, now, expansion, formatTimestamp }) => (
  <div className="flex flex-col gap-1.5">
    {runs.map((run, idx) => {
      const runKey = `${run.id ?? 'run'}:${run.name}:${idx}`;
      const isRunning = run.status === 'in_progress';
      const isQueued = run.status === 'queued';
      const failed = isFailedConclusion(run.conclusion);
      const expanded = expansion.runs.has(runKey);
      const hasDetails = Boolean(
        run.output?.title || run.output?.summary || run.output?.text
        || (run.annotations?.length ?? 0) > 0
        || (run.job?.steps?.length ?? 0) > 0
        || run.detailsUrl,
      );
      const workflowName = run.job?.workflowName;
      const durationLabel = isRunning
        ? formatElapsedDuration(run.startedAt, undefined, now)
        : formatElapsedDuration(run.startedAt, run.completedAt);
      return (
        <div key={runKey} className={cn('rounded-md border border-border/40', failed && 'border-[var(--status-error-border)]')}>
          <button
            type="button"
            disabled={!hasDetails}
            onClick={() => expansion.toggleRun(runKey)}
            className="flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
          >
            {isRunning ? (
              <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-[var(--status-warning)]" />
            ) : isQueued ? (
              <Icon name="time" className="size-4 shrink-0 text-muted-foreground" />
            ) : failed ? (
              <Icon name="close-circle" className="size-4 shrink-0 text-[var(--status-error)]" />
            ) : (
              <Icon name="checkbox-circle" className="size-4 shrink-0 text-[var(--status-success)]" />
            )}
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
              {workflowName && workflowName !== run.name ? `${workflowName} / ${run.name}` : run.name}
            </span>
            {durationLabel ? (
              <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">{durationLabel}</span>
            ) : null}
            {hasDetails ? (
              <Icon name="arrow-down-s" className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
            ) : null}
          </button>
          {expanded && hasDetails ? (
            <div className="min-w-0 overflow-hidden border-t border-border/40 p-2.5">
              <CheckRunDetails run={run} expansion={expansion} formatTimestamp={formatTimestamp} />
            </div>
          ) : null}
        </div>
      );
    })}
  </div>
);
