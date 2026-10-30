import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useToolbarFit } from '@/components/views/useDiffToolbarFit';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import type { I18nKey } from '@/lib/i18n/messages/en';
import { cn } from '@/lib/utils';
import { deleteWorkflowRun, fetchWorkflowRunDetail, startSavedWorkflow, type SavedWorkflow } from '@/lib/workflows/api';
import type { WorkflowRun, WorkflowRunDetail } from '@/lib/workflows/model';
import { useWorkflowPanelStore } from '@/lib/workflows/panel';
import { useWorkflowProjectScope } from '@/lib/workflows/project';
import { useSavedWorkflows } from '@/lib/workflows/saved';
import { useProjectWorkflowRuns, useWorkflowRunsStore } from '@/lib/workflows/store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { WorkflowAgentsView } from './WorkflowAgentsView';
import { WorkflowAnswerBlock } from './WorkflowAnswerBlock';
import { useWorkflowRunAction, workflowRunLook } from './workflowRunPresentation';

type View = 'agents' | 'log' | 'result' | 'script';

// The header gives up room in steps while its row does not fit (the CSS is in
// `index.css`): the view labels first, keeping their icons; then the action's
// label; last the run's name, leaving its state icon and the chevron. Every
// label shows while there is room, so choosing a view changes no widths.
const WORKFLOWS_HEADER_FIT = {
  steps: ['data-workflows-header-compact', 'data-workflows-header-tight', 'data-workflows-header-narrow'],
} as const;

const VIEWS: readonly { id: View; icon: IconName; labelKey: I18nKey }[] = [
  { id: 'agents', icon: 'flow-chart', labelKey: 'workflows.panel.view.agents' },
  { id: 'log', icon: 'file-list-2', labelKey: 'workflows.panel.view.log' },
  { id: 'result', icon: 'checkbox-circle', labelKey: 'workflows.panel.view.result' },
  { id: 'script', icon: 'code-sslash', labelKey: 'workflows.panel.view.script' },
];

// A running run's log refreshes at most this often, however fast its lines come.
const LOG_REFRESH_MS = 1_500;

/**
 * The run's log, script and result, read from the server when one of those
 * views opens and again when the run's state changes. While the log view
 * shows a running run, its new lines read it again, at most every
 * LOG_REFRESH_MS. Until the first read lands, the summary's recent lines stand
 * in for the log. Everything is kept per run, so switching runs never shows
 * the last run's detail or its failed read.
 */
type RunDetailState = { detail: WorkflowRunDetail | null; failed: boolean };

const useRunDetail = (run: WorkflowRun, view: View): RunDetailState => {
  const [detail, setDetail] = React.useState<WorkflowRunDetail | null>(null);
  const [failedRunId, setFailedRunId] = React.useState<string | null>(null);
  const lastRead = React.useRef<{ runId: string; at: number } | null>(null);
  const wanted = view !== 'agents';
  const logTick = view === 'log' && run.state === 'running' ? run.logs.at(-1)?.at ?? 0 : 0;
  React.useEffect(() => {
    if (!wanted) return;
    let current = true;
    // Only this run's own reads hold the next one back.
    const previous = lastRead.current?.runId === run.id ? lastRead.current.at : 0;
    const delay = Math.max(0, previous + LOG_REFRESH_MS - Date.now());
    const timer = setTimeout(() => {
      lastRead.current = { runId: run.id, at: Date.now() };
      fetchWorkflowRunDetail(run.id)
        .then((next) => {
          if (!current) return;
          setDetail(next);
          setFailedRunId(null);
        })
        .catch(() => { if (current) setFailedRunId(run.id); });
    }, delay);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [logTick, run.id, run.state, wanted]);
  const own = detail?.runId === run.id ? detail : null;
  return { detail: own, failed: failedRunId === run.id };
};

const formatLogTime = (at: number): string => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(at);

const LogView: React.FC<{ run: WorkflowRun; detail: WorkflowRunDetail | null }> = ({ run, detail }) => {
  const { t } = useI18n();
  const logs = detail?.logs ?? run.logs;
  if (logs.length === 0) {
    return <p className="px-4 py-6 typography-meta text-muted-foreground">{t('workflows.panel.log.empty')}</p>;
  }
  return (
    <ol className="flex flex-col gap-1 px-3 py-3">
      {logs.map((line, index) => (
        <li key={`${line.at}-${index}`} className="flex min-w-0 gap-3 typography-meta">
          <span className="shrink-0 tabular-nums text-muted-foreground" dir="ltr">{formatLogTime(line.at)}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-foreground" dir="auto">{line.message}</span>
        </li>
      ))}
    </ol>
  );
};

const ResultView: React.FC<{ run: WorkflowRun; detail: WorkflowRunDetail | null; failed: boolean }> = ({ run, detail, failed }) => {
  const { t } = useI18n();
  if (run.error && (run.state === 'failed' || run.state === 'stopped')) {
    return (
      <p className="px-4 py-6 typography-meta" style={{ color: run.state === 'failed' ? 'var(--status-error)' : undefined }}>
        {run.error}
      </p>
    );
  }
  if (run.state === 'awaiting-approval' || run.state === 'running' || run.state === 'declined') {
    return <p className="px-4 py-6 typography-meta text-muted-foreground">{t('workflows.panel.result.pending')}</p>;
  }
  if (failed && !detail) return <p className="px-4 py-6 typography-meta text-muted-foreground">{t('workflows.panel.detail.loadFailed')}</p>;
  if (!detail) return <p className="px-4 py-6 typography-meta text-muted-foreground">{t('workflows.panel.agent.loading')}<BusyDots /></p>;
  const { result } = detail;
  if (!result || (result.kind === 'json' && result.value === null)) {
    return <p className="px-4 py-6 typography-meta text-muted-foreground">{t('workflows.panel.result.none')}</p>;
  }
  return (
    <div className="px-4 py-3">
      <WorkflowAnswerBlock answer={result} />
    </div>
  );
};

const ScriptView: React.FC<{ detail: WorkflowRunDetail | null; failed: boolean }> = ({ detail, failed }) => {
  const { t } = useI18n();
  if (!detail) {
    return (
      <p className="px-4 py-6 typography-meta text-muted-foreground">
        {failed ? t('workflows.panel.detail.loadFailed') : <>{t('workflows.panel.agent.loading')}<BusyDots /></>}
      </p>
    );
  }
  const args = detail.args;
  // An empty object is what a run without args carries; anything else is worth showing.
  const hasArgs = args !== undefined && args !== null && JSON.stringify(args) !== '{}';
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {hasArgs ? (
        <section>
          <h4 className="typography-micro font-medium text-muted-foreground">{t('workflows.panel.script.args')}</h4>
          <pre dir="ltr" className="oc-tile mt-1 overflow-x-auto rounded-lg px-3 py-2 font-mono typography-micro text-foreground">{JSON.stringify(args, null, 2)}</pre>
        </section>
      ) : null}
      <pre dir="ltr" className="oc-tile overflow-x-auto rounded-lg px-3 py-2 font-mono typography-micro leading-relaxed text-foreground">{detail.script}</pre>
    </div>
  );
};

/** The actions for the run's state, in the header beside its picker. */
const RunAction: React.FC<{ run: WorkflowRun }> = ({ run }) => {
  const { t } = useI18n();
  const { pending, act } = useWorkflowRunAction();
  const busy = pending === run.id;
  if (run.state === 'awaiting-approval') {
    return (
      <>
        <Button type="button" size="sm" disabled={busy} onClick={() => act(run.id, 'approve')} aria-label={t('chat.workflow.action.run')}>
          <Icon name="play" className="size-3.5" />
          <span className="workflows-header__action-label">{t('chat.workflow.action.run')}</span>
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(run.id, 'decline')} aria-label={t('chat.workflow.action.decline')}>
          <Icon name="close" className="size-3.5" />
          <span className="workflows-header__action-label">{t('chat.workflow.action.decline')}</span>
        </Button>
      </>
    );
  }
  if (run.state === 'running') {
    return (
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(run.id, 'stop')} aria-label={t('chat.workflow.action.stop')}>
        <Icon name="stop" className="size-3.5" />
        <span className="workflows-header__action-label">{t('chat.workflow.action.stop')}</span>
      </Button>
    );
  }
  if (run.state === 'failed' || run.state === 'stopped') {
    return (
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(run.id, 'resume')} aria-label={t('chat.workflow.action.resume')}>
        <Icon name="restart" className="size-3.5" />
        <span className="workflows-header__action-label">{t('chat.workflow.action.resume')}</span>
      </Button>
    );
  }
  return null;
};

type SessionTitles = { get: (sessionId: string) => string | undefined };

/**
 * Session titles for runs of other sessions than the one on screen, from the
 * global session list: those sessions may sit in the project's worktrees.
 */
const useSessionTitles = (): SessionTitles => {
  const sessions = useGlobalSessionsStore((state) => state.entityById);
  return React.useMemo(() => ({ get: (sessionId) => sessions.get(sessionId)?.title }), [sessions]);
};

const RunItem: React.FC<{ run: WorkflowRun; selected: boolean; caption?: string; onSelect: () => void }> = ({ run, selected, caption, onSelect }) => {
  const { t } = useI18n();
  const look = workflowRunLook(run.state);
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Icon name={look.icon} className="size-3.5 shrink-0" style={look.color ? { color: look.color } : undefined} aria-label={t(look.labelKey)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" dir="auto">{run.name}</span>
        {caption ? <span className="truncate typography-micro text-muted-foreground" dir="auto">{caption}</span> : null}
      </span>
      {selected ? <Icon name="check" className="size-3.5 shrink-0" /> : null}
    </DropdownMenuItem>
  );
};

/**
 * Picks the run the panel shows: this session's runs first, then the other
 * sessions' with their session named, then the project's saved workflows to
 * run, and deleting the run on screen once it has finished.
 */
const RunPicker: React.FC<{
  runs: WorkflowRun[];
  selected: WorkflowRun;
  sessionId: string | null;
  sessionTitles: SessionTitles;
  saved: SavedWorkflow[];
  onSelect: (runId: string) => void;
  onRunSaved: (name: string) => void;
  /** Absent while the run is open: it is stopped or declined first. */
  onDelete: (() => void) | null;
}> = ({ runs, selected, sessionId, sessionTitles, saved, onSelect, onRunSaved, onDelete }) => {
  const { t } = useI18n();
  const look = workflowRunLook(selected.state);
  const newestFirst = runs.slice().reverse();
  const own = newestFirst.filter((run) => run.parentSessionId === sessionId);
  const others = newestFirst.filter((run) => run.parentSessionId !== sessionId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t('workflows.panel.runPicker')} className={cn(dropdownTriggerVariants(), 'max-w-[14rem] shrink-0')}>
          <Icon name={look.icon} className="size-3.5" style={look.color ? { color: look.color } : undefined} />
          <span className="workflows-header__run-name min-w-0 truncate" dir="auto">{selected.name}</span>
          <Icon name="arrow-down-s" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(var(--available-height),28rem)] w-[18rem] max-w-[calc(100vw-2rem)] overflow-y-auto">
        {own.length > 0 ? (
          <>
            <DropdownMenuLabel>{t('workflows.panel.picker.thisSession')}</DropdownMenuLabel>
            {own.map((run) => <RunItem key={run.id} run={run} selected={run.id === selected.id} onSelect={() => onSelect(run.id)} />)}
          </>
        ) : null}
        {others.length > 0 ? (
          <>
            {own.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{t('workflows.panel.picker.otherSessions')}</DropdownMenuLabel>
            {others.map((run) => (
              <RunItem
                key={run.id}
                run={run}
                selected={run.id === selected.id}
                caption={sessionTitles.get(run.parentSessionId) || t('workflows.panel.picker.untitledSession')}
                onSelect={() => onSelect(run.id)}
              />
            ))}
          </>
        ) : null}
        {saved.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('workflows.panel.picker.saved')}</DropdownMenuLabel>
            {saved.map((workflow) => (
              <DropdownMenuItem key={workflow.name} disabled={Boolean(workflow.error)} onSelect={() => onRunSaved(workflow.name)} title={workflow.error ?? workflow.description}>
                <Icon name="play" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" dir="auto">{workflow.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Icon name="delete-bin" className="size-3.5 shrink-0" />
              {t('workflows.panel.delete.action')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Runs a saved workflow after a confirmation: in the session on screen, or in
 * a new session when none is open (a draft), which then opens. The run is that
 * session's, as if its agent had started it.
 */
const useRunSavedWorkflow = (directory: string | null, scriptDirectory: string | null, sessionId: string | null, selectionKey: string) => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const select = useWorkflowPanelStore((state) => state.select);
  const run = React.useCallback(async (name: string) => {
    if (!directory || !scriptDirectory) return;
    const confirmed = await confirm({
      title: t('workflows.panel.saved.confirmTitle', { name }),
      message: sessionId ? t('workflows.panel.saved.confirmHere') : t('workflows.panel.saved.confirmNew'),
      action: t('workflows.panel.saved.confirmAction'),
    });
    if (!confirmed) return;
    try {
      const started = await startSavedWorkflow({ directory, scriptDirectory, sessionId, name });
      if (sessionId) {
        select(selectionKey, started.runId);
      } else {
        select(started.sessionId, started.runId);
        useSessionUIStore.getState().setCurrentSession(started.sessionId, directory);
      }
    } catch (error) {
      toast.error(t('workflows.panel.saved.failed'), { description: error instanceof Error ? error.message : undefined });
    }
  }, [confirm, directory, scriptDirectory, select, selectionKey, sessionId, t]);
  return { run, dialog };
};

/** No runs yet: the project's saved workflows, each one click from running. */
const EmptyState: React.FC<{ saved: SavedWorkflow[]; onRunSaved: (name: string) => void }> = ({ saved, onRunSaved }) => {
  const { t } = useI18n();
  if (saved.length === 0) {
    return <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">{t('workflows.panel.emptyProject')}</div>;
  }
  return (
    <div className="flex flex-col gap-1 px-3 py-3">
      <p className="typography-meta text-muted-foreground">{t('workflows.panel.emptyProject')}</p>
      <h4 className="mt-2 typography-micro font-medium text-muted-foreground">{t('workflows.panel.picker.saved')}</h4>
      {saved.map((workflow) => (
        <div key={workflow.name} className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate typography-meta text-foreground" dir="auto">{workflow.name}</div>
            {workflow.description || workflow.error ? (
              <div className="truncate typography-micro text-muted-foreground" dir="auto" title={workflow.error ?? workflow.description}>{workflow.error ?? workflow.description}</div>
            ) : null}
          </div>
          <Button type="button" size="sm" variant="outline" disabled={Boolean(workflow.error)} onClick={() => onRunSaved(workflow.name)} aria-label={t('workflows.panel.saved.runAria', { name: workflow.name })}>
            <Icon name="play" className="size-3.5" />
            {t('workflows.panel.saved.confirmAction')}
          </Button>
        </div>
      ))}
    </div>
  );
};

/**
 * The context panel's Workflows surface: the workflow runs of the project,
 * one at a time, the session on screen's newest first. The header carries the
 * run picker, the views, the run's action, and for another session's run a
 * way to that session; the body shows the agents by phase, the log, the result
 * or the script. With no runs, the project's saved workflows wait to be run.
 */
export const WorkflowsPanel: React.FC<{ directory: string | null }> = ({ directory }) => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const scope = useWorkflowProjectScope(directory);
  const runs = useProjectWorkflowRuns(scope);
  const saved = useSavedWorkflows(scope?.savedDirectory ?? null);
  const selectionKey = sessionId ?? `directory:${directory ?? ''}`;
  const selectedId = useWorkflowPanelStore((state) => state.selectedBySession[selectionKey]);
  const { run: runSaved, dialog } = useRunSavedWorkflow(directory, scope?.savedDirectory ?? null, sessionId, selectionKey);
  const run = runs.find((candidate) => candidate.id === selectedId)
    ?? runs.filter((candidate) => candidate.parentSessionId === sessionId).at(-1)
    ?? runs.at(-1)
    ?? null;

  return (
    <>
      {dialog}
      {run
        ? <WorkflowRunView sessionId={sessionId} selectionKey={selectionKey} runs={runs} saved={saved} run={run} directory={directory} onRunSaved={(name) => void runSaved(name)} />
        : <EmptyState saved={saved} onRunSaved={(name) => void runSaved(name)} />}
    </>
  );
};

const WorkflowRunView: React.FC<{
  sessionId: string | null;
  selectionKey: string;
  runs: WorkflowRun[];
  saved: SavedWorkflow[];
  run: WorkflowRun;
  directory: string | null;
  onRunSaved: (name: string) => void;
}> = ({ sessionId, selectionKey, runs, saved, run, directory, onRunSaved }) => {
  const { t } = useI18n();
  const select = useWorkflowPanelStore((state) => state.select);
  const sessionTitles = useSessionTitles();
  const [view, setView] = React.useState<View>('agents');
  const { detail, failed } = useRunDetail(run, view);
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  useToolbarFit(headerRef, WORKFLOWS_HEADER_FIT);
  const { confirm, dialog } = useConfirmDialog();
  const open = run.state === 'running' || run.state === 'awaiting-approval';
  const foreign = run.parentSessionId !== sessionId;

  const deleteRun = async () => {
    const confirmed = await confirm({
      title: t('workflows.panel.delete.title', { name: run.name }),
      message: t('workflows.panel.delete.message'),
      action: t('workflows.panel.delete.confirm'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await deleteWorkflowRun(run.id);
      // The server's event does the same; this keeps the panel from waiting on it.
      useWorkflowRunsStore.getState().remove(run.parentSessionId, run.id);
    } catch (error) {
      toast.error(t('workflows.panel.delete.failed'), { description: error instanceof Error ? error.message : undefined });
    }
  };

  const openOwnerSession = () => {
    // Keeps showing this run there: the panel picks its run per session.
    select(run.parentSessionId, run.id);
    useSessionUIStore.getState().setCurrentSession(run.parentSessionId, run.directory);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <ContextPanelHeaderToolbar>
        <div ref={headerRef} className="workflows-header flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden ps-1 pe-1">
          <RunPicker
            runs={runs}
            selected={run}
            sessionId={sessionId}
            sessionTitles={sessionTitles}
            saved={saved}
            onSelect={(runId) => select(selectionKey, runId)}
            onRunSaved={onRunSaved}
            onDelete={open ? null : () => void deleteRun()}
          />
          {/* Never shrinks: a squeezed strip would slide under the buttons after it
              instead of overflowing the row, and only an overflow makes the
              header give up labels. The spacer after it takes the free room. */}
          <nav className="flex shrink-0 items-center gap-1" aria-label={t('workflows.panel.view.label')}>
            {VIEWS.map((entry) => {
              const active = entry.id === view;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setView(entry.id)}
                  aria-current={active ? 'page' : undefined}
                  title={t(entry.labelKey)}
                  aria-label={t(entry.labelKey)}
                  className={cn(
                    'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors',
                    active ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon name={entry.icon} className="size-3.5 shrink-0" />
                  <span className="workflows-header__label whitespace-nowrap typography-meta">{t(entry.labelKey)}</span>
                </button>
              );
            })}
          </nav>
          <div aria-hidden className="min-w-0 flex-1" />
          {foreign ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={openOwnerSession}
              aria-label={t('workflows.panel.agent.openSession')}
              title={sessionTitles.get(run.parentSessionId) || t('workflows.panel.picker.untitledSession')}
            >
              <Icon name="chat-4" className="size-3.5" />
              <span className="workflows-header__action-label">{t('workflows.panel.agent.openSession')}</span>
            </Button>
          ) : null}
          <RunAction run={run} />
        </div>
      </ContextPanelHeaderToolbar>
      {/* The agents view scrolls its list above a fixed summary line; the others scroll whole. */}
      {view === 'agents' ? (
        <div className="min-h-0 flex-1"><WorkflowAgentsView key={run.id} run={run} directory={directory} /></div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === 'log' ? <LogView run={run} detail={detail} /> : null}
          {view === 'result' ? <ResultView run={run} detail={detail} failed={failed} /> : null}
          {view === 'script' ? <ScriptView detail={detail} failed={failed} /> : null}
        </div>
      )}
    </div>
  );
};
