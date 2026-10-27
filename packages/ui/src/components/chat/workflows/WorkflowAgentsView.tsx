import React from 'react';

import { formatCost } from '@/components/chat/work-status/subagentCost';
import { formatTelemetryDuration, formatTelemetryTokens } from '@/components/chat/work-status/telemetry';
import { useOpenChildSession } from '@/components/chat/work-status/useOpenChildSession';
import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fetchWorkflowAgentDetail } from '@/lib/workflows/api';
import {
  groupWorkflowAgentsByPhase,
  workflowAgentTokens,
  workflowAgentsTotals,
  workflowRunTotals,
  type WorkflowAgent,
  type WorkflowAgentDetail,
  type WorkflowRun,
} from '@/lib/workflows/model';
import { WorkflowAnswerBlock } from './WorkflowAnswerBlock';
import { workflowAgentLook } from './workflowRunPresentation';

type PhaseGroup = ReturnType<typeof groupWorkflowAgentsByPhase>[number];

/** The model id without its provider, the part that tells two agents apart. */
const shortModel = (model: string): string => model.slice(model.indexOf('/') + 1);

/** A span of time, live while it has no end. Ticks only itself. */
const Duration: React.FC<{ start: number | undefined; end: number | undefined; className?: string }> = ({ start, end, className }) => {
  const now = useDurationTickerNow(start !== undefined && end === undefined);
  if (start === undefined) return null;
  return <span className={cn('shrink-0 whitespace-nowrap tabular-nums', className)} dir="auto">{formatTelemetryDuration((end ?? now) - start)}</span>;
};

type PhaseSpan = { start: number | undefined; end: number | undefined };

const phaseSpan = (agents: WorkflowAgent[]): PhaseSpan => {
  const starts = agents.flatMap((agent) => (agent.startedAt === undefined || agent.replayed ? [] : [agent.startedAt]));
  if (starts.length === 0) return { start: undefined, end: undefined };
  const open = agents.some((agent) => agent.state === 'running' || agent.state === 'queued');
  const ends = agents.flatMap((agent) => (agent.endedAt === undefined ? [] : [agent.endedAt]));
  return { start: Math.min(...starts), end: open ? undefined : Math.max(...ends, ...starts) };
};

/** One tile per phase: how many of its agents finished, for how long, and a bar of it. */
const PhaseStrip: React.FC<{ run: WorkflowRun; groups: PhaseGroup[] }> = ({ run, groups }) => {
  const { t } = useI18n();
  const titled = groups.filter((group) => group.title !== null);
  if (titled.length === 0) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {titled.map((group) => {
        const total = group.agents.length;
        const span = phaseSpan(group.agents);
        const current = run.state === 'running' && run.currentPhase === group.title;
        return (
          <div key={group.title} className="oc-tile min-w-[7.5rem] flex-1 rounded-lg px-2.5 py-2">
            <div className={cn('truncate typography-meta', current ? 'font-semibold text-foreground' : 'text-foreground')} dir="auto">{group.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 typography-micro text-muted-foreground">
              {total > 0 ? <span className="tabular-nums" dir="auto">{`${group.done}/${total}`}</span> : <span>{t('workflows.panel.phase.waiting')}</span>}
              {total > 0 ? <Duration start={span.start} end={span.end} className="ms-auto" /> : null}
            </div>
            <div className="oc-tile-inset mt-1.5 h-1 overflow-hidden rounded-full">
              {total > 0 ? (
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round((group.done / total) * 100)}%`,
                    background: group.failed > 0 ? 'var(--status-warning)' : 'var(--status-success)',
                  }}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** What opens under an agent's row: its prompt and full answer, read when opened. */
const AgentDetails: React.FC<{ run: WorkflowRun; agent: WorkflowAgent; onOpenSession: (() => void) | null }> = ({ run, agent, onOpenSession }) => {
  const { t } = useI18n();
  const [detail, setDetail] = React.useState<WorkflowAgentDetail | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [promptOpen, setPromptOpen] = React.useState(false);

  // Read again when the agent's state moves on, so a finished answer replaces "no answer yet".
  React.useEffect(() => {
    let current = true;
    setFailed(false);
    fetchWorkflowAgentDetail(run.id, agent.key)
      .then((next) => { if (current) setDetail(next); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [agent.key, agent.state, run.id]);

  return (
    <div className="oc-tile mb-1.5 ms-5 flex flex-col gap-2 rounded-lg px-3 py-2.5">
      {agent.error ? <p className="typography-meta" style={{ color: agent.state === 'failed' ? 'var(--status-error)' : undefined }}>{agent.error}</p> : null}
      {failed ? <p className="typography-meta text-muted-foreground">{t('workflows.panel.agent.loadFailed')}</p> : null}
      {!detail && !failed ? <p className="typography-meta text-muted-foreground">{t('workflows.panel.agent.loading')}<BusyDots /></p> : null}
      {detail ? (
        <>
          <section>
            <h4 className="typography-micro font-medium text-muted-foreground">{t('workflows.panel.agent.answer')}</h4>
            <div className="mt-1">
              {detail.result === undefined
                ? <p className="typography-meta text-muted-foreground">{t('workflows.panel.agent.noAnswer')}</p>
                : <WorkflowAnswerBlock answer={detail.result} />}
            </div>
          </section>
          <section>
            <button
              type="button"
              onClick={() => setPromptOpen((open) => !open)}
              aria-expanded={promptOpen}
              className="flex items-center gap-1 typography-micro font-medium text-muted-foreground hover:text-foreground"
            >
              <Icon name="arrow-right-s" className={cn('size-3.5 transition-transform', promptOpen && 'rotate-90 rtl:-rotate-90')} />
              {t('workflows.panel.agent.prompt')}
            </button>
            {promptOpen ? (
              <pre dir="auto" className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono typography-micro text-foreground">{detail.prompt}</pre>
            ) : null}
          </section>
        </>
      ) : null}
      {onOpenSession ? (
        <div>
          <Button type="button" size="xs" variant="ghost" onClick={onOpenSession}>
            <Icon name="chat-4" className="size-3.5" />
            {t('workflows.panel.agent.openSession')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

const AgentRow: React.FC<{
  run: WorkflowRun;
  agent: WorkflowAgent;
  /** Off when the phase header already names the one model all its agents ran on. */
  showModel: boolean;
  /** Whether the run has any spend to show; columns without numbers are left out. */
  columns: SpendColumns;
  open: boolean;
  onToggle: () => void;
  onOpenSession: (() => void) | null;
}> = ({ run, agent, showModel, columns, open, onToggle, onOpenSession }) => {
  const { t } = useI18n();
  const look = workflowAgentLook(agent.state);
  const tokens = workflowAgentTokens(agent);
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={agent.label}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-start typography-meta text-foreground/80 hover:text-foreground"
      >
        <Icon name={look.icon} className="size-3.5 shrink-0" style={look.color ? { color: look.color } : undefined} aria-label={t(look.labelKey)} />
        <span className="min-w-0 flex-1 truncate" dir="auto">{agent.label}</span>
        {agent.replayed ? <span className="shrink-0 typography-micro text-muted-foreground">{t('chat.workflow.agent.reused')}</span> : null}
        {showModel && agent.model ? (
          <span className="oc-tile-inset max-w-[9rem] shrink-0 truncate rounded-full px-1.5 typography-micro text-muted-foreground" title={agent.model} dir="ltr">
            {shortModel(agent.model)}
          </span>
        ) : null}
        <Duration start={agent.replayed ? undefined : agent.startedAt} end={agent.endedAt} className="min-w-12 text-end typography-micro text-muted-foreground" />
        {columns.tokens ? (
          <span className="min-w-12 shrink-0 whitespace-nowrap text-end tabular-nums typography-micro text-muted-foreground" dir="auto">
            {tokens === null || agent.replayed ? '' : formatTelemetryTokens(tokens)}
          </span>
        ) : null}
        {columns.cost ? (
          <span className="min-w-14 shrink-0 whitespace-nowrap text-end tabular-nums typography-micro text-muted-foreground" dir="ltr">
            {agent.usage && !agent.replayed && agent.usage.cost > 0 ? formatCost(agent.usage.cost) : ''}
          </span>
        ) : null}
      </button>
      {open ? <AgentDetails run={run} agent={agent} onOpenSession={onOpenSession} /> : null}
    </>
  );
};

type SpendColumns = { tokens: boolean; cost: boolean };

/** Tokens and cost of some agents as one short line, or null when none was measured. */
const spendText = (agents: readonly WorkflowAgent[], columns: SpendColumns): string | null => {
  const totals = workflowAgentsTotals(agents);
  if (totals.measured === 0) return null;
  const parts = [];
  if (columns.tokens) parts.push(formatTelemetryTokens(totals.tokens));
  // Providers on a subscription report a cost of zero; that is no price to show.
  if (columns.cost && totals.cost > 0) parts.push(formatCost(totals.cost));
  return parts.length > 0 ? parts.join(' · ') : null;
};

/** The one model every agent of a phase ran on, named once in its header; null when they differ. */
const phaseModel = (agents: WorkflowAgent[]): string | null => {
  const models = new Set(agents.map((agent) => agent.model ?? null));
  const [only] = models;
  return models.size === 1 && only ? shortModel(only) : null;
};

/**
 * The run's agents: a tile per phase, then each phase's agents with their
 * model, time and tokens. A finished phase folds while another one runs, so
 * the work in progress stays in view; a row opens to the agent's answer.
 */
export const WorkflowAgentsView: React.FC<{ run: WorkflowRun; directory: string | null }> = ({ run, directory }) => {
  const { t } = useI18n();
  const groups = React.useMemo(() => groupWorkflowAgentsByPhase(run), [run]);
  const openChildSession = useOpenChildSession(directory);
  const [openAgents, setOpenAgents] = React.useState<ReadonlySet<string>>(() => new Set());
  const [toggledPhases, setToggledPhases] = React.useState<ReadonlySet<string>>(() => new Set());
  const totals = workflowRunTotals(run);
  // Runs without spend (sessions gone, a provider that reports no cost) get no empty columns.
  const columns: SpendColumns = { tokens: totals.measured > 0, cost: totals.cost > 0 };
  const done = run.agents.filter((agent) => agent.state === 'completed').length;

  const flip = (set: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, key: string) => set((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <PhaseStrip run={run} groups={groups} />
        {groups.map((group) => {
          if (group.agents.length === 0) return null;
          const key = group.title ?? '';
          const finished = group.done + group.failed === group.agents.length;
          const foldedByDefault = run.state === 'running' && finished;
          const expanded = foldedByDefault === toggledPhases.has(key);
          const model = phaseModel(group.agents);
          const spend = spendText(group.agents, columns);
          return (
            <section key={key} className="mt-3">
              <button
                type="button"
                onClick={() => flip(setToggledPhases, key)}
                aria-expanded={expanded}
                className="flex h-7 w-full min-w-0 items-center gap-1.5 text-start typography-micro font-medium text-muted-foreground hover:text-foreground"
              >
                <Icon name="arrow-right-s" className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90 rtl:-rotate-90')} />
                <span className="min-w-0 truncate" dir="auto">{group.title ?? t('chat.workflow.phase.unphased')}</span>
                {model ? <span className="min-w-0 truncate font-normal" dir="ltr">{`· ${model}`}</span> : null}
                {spend ? <span className="ms-auto shrink-0 tabular-nums font-normal" dir="ltr">{spend}</span> : null}
                <span className={cn('shrink-0 tabular-nums font-normal', !spend && 'ms-auto')} dir="auto">
                  {spend ? `· ${group.done}/${group.agents.length}` : `${group.done}/${group.agents.length}`}
                </span>
              </button>
              {expanded ? group.agents.map((agent) => {
                const sessionId = agent.sessionId;
                return (
                  <AgentRow
                    key={agent.key}
                    run={run}
                    agent={agent}
                    showModel={model === null}
                    columns={columns}
                    open={openAgents.has(agent.key)}
                    onToggle={() => flip(setOpenAgents, agent.key)}
                    onOpenSession={sessionId ? () => openChildSession(sessionId, agent.label) : null}
                  />
                );
              }) : null}
            </section>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 border-t border-border/60 px-3 py-2 typography-micro text-muted-foreground">
        <span className="tabular-nums" dir="auto">{t('workflows.panel.summary.agents', { done, total: run.agents.length })}</span>
        {run.startedAt !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <Duration start={run.startedAt} end={run.state === 'running' ? undefined : run.endedAt ?? run.startedAt} />
          </>
        ) : null}
        {totals.measured > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums" dir="auto">{t('workflows.panel.summary.tokens', { tokens: formatTelemetryTokens(totals.tokens) })}</span>
            {totals.cost > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums" dir="ltr">{formatCost(totals.cost)}</span>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
};
