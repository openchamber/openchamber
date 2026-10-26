import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { RowMarkTooltip } from '@/components/session/sidebar/sessions/RowMarkTooltip';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import {
  isNothingLost,
  type OverviewActivity,
  type OverviewCleanupRow,
  type OverviewDoneSignal,
  type OverviewSessionSections,
  type OverviewVeto,
  type OverviewWaitingReason,
  type OverviewWorktreeLosses,
} from '@/lib/overview/overviewModel';
import { normalizePath } from '@/lib/pathNormalization';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { cn } from '@/lib/utils';
import { getWorktreeDisplayName } from '@/lib/worktrees/worktreeManager';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { markOverviewSessionsDone, removeOverviewWorktree, type OverviewRemoveOutcome, type OverviewWorktreeTarget } from './overviewActions';
import { useOverviewData, useOverviewReviewRequests, type OverviewData, type OverviewWorktree } from './useOverviewData';

type Layout = 'page' | 'mobile';

// The page speaks the sidebar's language: the same marks for a request, an
// unread end and a running turn, and the title in bold where something waits
// on the user. Colour stays on the marks and on the notes that name a state;
// everything else is the page's text colour or muted. Every row carries its
// own action, since the page exists to act without opening each session.

type Mark = { icon: IconName; color: string; tint?: boolean };

const WAITING_MARK = {
  permission: { icon: 'shield', color: 'var(--status-error)', tint: true },
  question: { icon: 'question', color: 'var(--status-info)', tint: true },
  error: { icon: 'error-warning', color: 'var(--status-error)' },
  conflict: { icon: 'git-pull-request', color: 'var(--pr-blocked)' },
  checks: { icon: 'git-pull-request', color: 'var(--pr-blocked)' },
  // The unread mark is the sidebar's own component; this entry is not drawn.
  finished: { icon: 'checkbox-circle', color: 'var(--status-success)' },
} satisfies Record<OverviewWaitingReason, Mark>;

const SIGNAL_MARK = {
  merged: { icon: 'git-merge', color: 'var(--pr-merged)' },
  issueClosed: { icon: 'record-circle', color: 'var(--pr-merged)' },
  issueDropped: { icon: 'close-circle', color: 'var(--pr-closed)' },
  hint: { icon: 'sparkling', color: 'var(--status-info)' },
} satisfies Record<OverviewDoneSignal, Mark>;

const WAITING_KEY = {
  permission: 'overview.reason.permission',
  question: 'overview.reason.question',
  error: 'overview.reason.error',
  conflict: 'overview.reason.conflict',
  checks: 'overview.reason.checks',
  finished: 'overview.reason.finished',
} satisfies Record<OverviewWaitingReason, I18nKey>;

/** Which waiting reasons are named beside the title; an unread end says enough with its mark. */
const NAMED_WAITING = new Set<OverviewWaitingReason>(['permission', 'question', 'error', 'conflict', 'checks']);

const ACTIVITY_KEY = {
  running: 'overview.activity.running',
  subagent: 'overview.activity.subagent',
  shell: 'overview.activity.shell',
} satisfies Record<OverviewActivity, I18nKey>;

const SIGNAL_KEY = {
  merged: 'overview.signal.merged',
  issueClosed: 'overview.signal.issueClosed',
  issueDropped: 'overview.signal.issueDropped',
  hint: 'overview.signal.hint',
} satisfies Record<OverviewDoneSignal, I18nKey>;

const VETO_KEY = {
  failed: 'overview.veto.failed',
  suggestion: 'overview.veto.suggestion',
  uncommitted: 'overview.veto.uncommitted',
} satisfies Record<OverviewVeto, I18nKey>;

/** Why Clean up left a worktree as it is. */
const LEFT_AS_IS_KEY = {
  busy: 'overview.toast.busy',
  inUse: 'overview.toast.inUse',
  unknown: 'overview.toast.unknown',
  changed: 'overview.toast.changed',
} satisfies Record<Exclude<OverviewRemoveOutcome['kind'], 'removed' | 'failed'>, I18nKey>;

type SectionId = 'waiting' | 'running' | 'done' | 'working' | 'cleanup';

/** A row's leading mark, named in a tooltip; a tinted one sits on a fill of its colour, as the sidebar's request marks do. */
const RowMark: React.FC<{ mark: Mark; label: string }> = ({ mark, label }) => (
  <RowMarkTooltip label={label}>
    <span
      aria-label={label}
      className={cn('inline-flex shrink-0 items-center justify-center rounded', mark.tint && 'px-1 py-0.5')}
      style={{ color: mark.color, backgroundColor: mark.tint ? `color-mix(in srgb, ${mark.color} 12%, transparent)` : undefined }}
    >
      <Icon name={mark.icon} className="size-3" />
    </span>
  </RowMarkTooltip>
);

/**
 * One row in the sidebar's shape: a mark slot, the title, the reason it is
 * here beside it, then the project, the time and the row's actions at the
 * end. The actions are on the row at rest, quiet until the row is hovered,
 * so nothing moves and nothing has to be discovered. A second line under the
 * title carries what helps decide: a recap, the question asked. Opening is a
 * button of its own over the text, so the actions beside it stay buttons too.
 */
const OverviewRow: React.FC<{
  layout: Layout;
  mark?: React.ReactNode;
  title: string;
  /** Bold, as an unread row in the sidebar. */
  strong?: boolean;
  /** Plain text title: a branch name, a count line. */
  plain?: boolean;
  note?: string | null;
  noteColor?: string;
  sub?: string | null;
  end?: React.ReactNode;
  actions?: React.ReactNode;
  onOpen?: (event: React.MouseEvent) => void;
}> = ({ layout, mark, title, strong, plain, note, noteColor, sub, end, actions, onOpen }) => {
  const touch = layout === 'mobile';
  const body = (
    <>
      <span className="flex min-h-6 min-w-0 items-center gap-2">
        <span className="inline-flex w-4 shrink-0 justify-center">{mark}</span>
        <span
          dir="auto"
          className={cn(
            'min-w-0 shrink truncate oc-ui-start-align typography-ui-label text-foreground',
            // The title carries the row: always full strength, bolder where
            // something waits on the user; everything around it is smaller and muted.
            strong ? 'font-semibold' : plain ? 'font-normal' : 'font-medium',
          )}
        >
          {title}
        </span>
        {note ? (
          <span className="shrink-0 whitespace-nowrap typography-micro text-muted-foreground/80" style={noteColor ? { color: noteColor } : undefined}>{note}</span>
        ) : null}
      </span>
      {sub ? <span dir="auto" title={sub} className="truncate oc-ui-start-align ps-6 typography-micro text-muted-foreground/80">{sub}</span> : null}
    </>
  );
  const bodyClass = 'flex min-w-0 flex-1 flex-col gap-0.5 text-start';
  return (
    <div className="group flex min-w-0 items-center gap-4 rounded-lg px-2 py-1.5">
      {onOpen ? (
        <button type="button" onClick={onOpen} className={cn(bodyClass, 'cursor-pointer focus-visible:outline-none')}>{body}</button>
      ) : (
        <div className={bodyClass}>{body}</div>
      )}
      {end ? <span className="flex min-h-6 shrink-0 items-center gap-3 whitespace-nowrap typography-micro tabular-nums text-muted-foreground">{end}</span> : null}
      {actions ? (
        <span className={cn('flex min-h-6 shrink-0 items-center gap-1', !touch && 'opacity-70 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100')}>
          {actions}
        </span>
      ) : null}
    </div>
  );
};

/** The project at a row's end: its name, after a dot in its colour when it has one. */
const ProjectLabel: React.FC<{ label: string; color: string | null }> = ({ label, color }) => (
  <span className="inline-flex max-w-44 items-center gap-1.5">
    {color ? <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /> : null}
    <span dir="auto" className="truncate">{label}</span>
  </span>
);

/**
 * A section: its name, count and action, then its rows. Sections are told
 * apart by space and a hairline above, not by fills.
 */
const Section = React.forwardRef<HTMLElement, {
  label: string;
  count: string;
  hint?: string;
  action?: React.ReactNode;
  divider?: boolean;
  children: React.ReactNode;
}>(({ label, count, hint, action, divider = true, children }, ref) => (
  <section ref={ref} className={cn('flex min-w-0 scroll-mt-4 flex-col gap-0.5', divider && 'border-t border-border/50 pt-5')}>
    <div className="mb-0.5 flex min-h-7 items-center gap-2 px-2">
      <span className="typography-ui-label font-medium text-foreground">{label}</span>
      <span className="typography-ui-label tabular-nums text-muted-foreground">{count}</span>
      {hint ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{hint}</span> : null}
      <span className="flex-1" />
      {action}
    </div>
    <div className="flex flex-col">{children}</div>
  </section>
));
Section.displayName = 'OverviewSection';

type BulkItem = { key: string; title: string; reason: string };

/** Asks before a bulk action: what it touches, each with its reason, and what it leaves out and why. */
const BulkConfirmDialog: React.FC<{
  request: { title: string; description: string; action: string; items: BulkItem[]; leftOut: BulkItem[] } | null;
  onSettle: (confirmed: boolean) => void;
}> = ({ request, onSettle }) => {
  const { t } = useI18n();
  const [showLeftOut, setShowLeftOut] = React.useState(false);
  React.useEffect(() => {
    if (!request) setShowLeftOut(false);
  }, [request]);
  const itemLine = (item: BulkItem) => (
    <li key={item.key} className="flex min-w-0 items-baseline gap-2 py-0.5">
      <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label text-foreground">{item.title}</span>
      <span className="shrink-0 typography-micro text-muted-foreground">{item.reason}</span>
    </li>
  );
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) onSettle(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 overflow-y-auto">{request?.items.map(itemLine)}</ul>
        {request && request.leftOut.length > 0 ? (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setShowLeftOut((value) => !value)}
              aria-expanded={showLeftOut}
              className="flex items-center gap-1 self-start typography-micro text-muted-foreground hover:text-foreground"
            >
              <Icon name="arrow-right-s" className={cn('size-3.5 transition-transform', showLeftOut && 'rotate-90 rtl:-rotate-90')} />
              {t('overview.bulk.leftOut', { count: request.leftOut.length })}
            </button>
            {showLeftOut ? <ul className="max-h-40 overflow-y-auto">{request.leftOut.map(itemLine)}</ul> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="outline" autoFocus onClick={() => onSettle(false)}>{t('dialog.common.actions.cancel')}</Button>
          <Button size="sm" onClick={() => onSettle(true)}>{request?.action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

type BulkRequest = React.ComponentProps<typeof BulkConfirmDialog>['request'];

function useBulkConfirm() {
  const [request, setRequest] = React.useState<BulkRequest>(null);
  const pending = React.useRef<((confirmed: boolean) => void) | null>(null);
  React.useEffect(() => () => pending.current?.(false), []);
  const settle = React.useCallback((confirmed: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);
  const ask = React.useCallback((next: NonNullable<BulkRequest>) => {
    pending.current?.(false);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setRequest(next);
    });
  }, []);
  return { ask, dialog: <BulkConfirmDialog request={request} onSettle={settle} /> };
}

/**
 * The worktree a Looks done row may clean up: its PR merged, nothing to lose,
 * nothing there running or open, and no other session there still in work,
 * whose work Clean up would close with it.
 */
const removalTarget = (data: OverviewData, session: Session): OverviewWorktree | null => {
  const entry = data.worktreeOf(session);
  if (!entry || entry.pr !== 'merged' || data.isWorktreeInUse(entry.worktree.path)) return null;
  const git = data.gitOf(entry.worktree.path);
  if (!git || !isNothingLost(git.losses)) return null;
  const othersInWork = data.sessionsIn(entry.worktree.path)
    .some((other) => other.id !== session.id && !other.parentID && isSessionInWork(other));
  return othersInWork ? null : entry;
};

type WorkingRow = OverviewSessionSections['working'][number];

/** The in-work sessions of one project: the recent ones first, then the stalled ones. */
type ProjectGroup = { label: string; color: string | null; rows: WorkingRow[]; stalled: number };

const groupByProject = (data: OverviewData, sections: OverviewSessionSections): ProjectGroup[] => {
  const groups = new Map<string, ProjectGroup>();
  for (const row of [...sections.working, ...sections.stalled]) {
    const project = data.projectOf(row.session);
    let group = groups.get(project.label);
    if (!group) {
      group = { label: project.label, color: project.color, rows: [], stalled: 0 };
      groups.set(project.label, group);
    }
    group.rows.push(row);
    if (row.stalled) group.stalled += 1;
  }
  return [...groups.values()].sort((left, right) => right.rows.length - left.rows.length);
};

export function OverviewPage({ layout, onLeave }: { layout: Layout; onLeave: () => void }): React.ReactNode {
  const { t } = useI18n();
  const data = useOverviewData();
  const reviews = useOverviewReviewRequests();
  const blockingBySession = useGlobalBlockingRequestsStore((state) => state.bySession);
  const openTrackerItem = useOpenTrackerItem();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const { ask, dialog: bulkDialog } = useBulkConfirm();
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());
  const [reviewsOpen, setReviewsOpen] = React.useState(false);
  const [openProjects, setOpenProjects] = React.useState<ReadonlySet<string>>(new Set());
  const sectionRefs = React.useRef(new Map<SectionId, HTMLElement>());
  const { sections } = data;
  const mobile = layout === 'mobile';

  const run = React.useCallback(async (keys: readonly string[], task: () => Promise<void>) => {
    setPending((current) => new Set([...current, ...keys]));
    try {
      await task();
    } finally {
      setPending((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
    }
  }, []);

  const titleOf = React.useCallback((session: Session) => session.title || t('sessions.sidebar.session.untitled'), [t]);
  const recapOf = (session: Session) => getCurrentSessionAssist(session)?.recap || null;
  // The question or form a session waits on, named under its title when it has one.
  const askedOf = (session: Session): string | null => {
    const requests = blockingBySession.get(session.id);
    return requests?.forms[0]?.title || requests?.pages[0]?.title || null;
  };

  // The project is named only when the page spans more than one: with one,
  // the same name on every row says nothing.
  const listedSessions = [
    ...sections.waiting, ...sections.running, ...sections.done, ...sections.working, ...sections.stalled,
  ].map((row) => row.session);
  const manyProjects = new Set(listedSessions.map((session) => data.projectOf(session).label)).size > 1;
  const endOf = (session: Session, time: React.ReactNode = formatSessionCompactDateLabel(session.time.updated), project = manyProjects) => {
    const entry = data.projectOf(session);
    return (
      <>
        {project ? <ProjectLabel label={entry.label} color={entry.color} /> : null}
        <span>{time}</span>
      </>
    );
  };

  const openSession = (session: Session) => {
    const directory = normalizePath(resolveGlobalSessionDirectory(session));
    setCurrentSession(session.id, directory ?? undefined);
    onLeave();
  };

  const markDone = (sessions: Session[]) => run(sessions.map((session) => session.id), async () => {
    const failed = await markOverviewSessionsDone(sessions);
    for (const session of failed) toast.error(t('overview.toast.doneFailed', { title: titleOf(session) }));
  });

  const removeOne = async (target: OverviewWorktreeTarget, agreed: OverviewWorktreeLosses) => {
    const name = worktreeName(target);
    const outcome = await removeOverviewWorktree({ target, agreed });
    if (outcome.kind === 'removed') {
      toast.success(t('overview.toast.removed', { name }));
    } else if (outcome.kind === 'failed') {
      toast.error(t('overview.toast.removeFailed', { name }), { description: outcome.error.message });
    } else {
      toast.info(t(LEFT_AS_IS_KEY[outcome.kind], { name }));
    }
  };

  const removeWorktree = (target: OverviewWorktreeTarget, agreed: OverviewWorktreeLosses) => run([target.worktree.path], async () => {
    await removeOne(target, agreed);
    data.refreshGit();
  });

  const listFormat = new Intl.ListFormat(getCurrentIntlLocale(), { type: 'conjunction' });
  const lossLines = (losses: OverviewWorktreeLosses): string[] => {
    const lines: string[] = [];
    if (losses.uncommittedFiles === 1) lines.push(t('overview.losses.uncommittedOne'));
    else if (losses.uncommittedFiles > 1) lines.push(t('overview.losses.uncommittedMany', { count: losses.uncommittedFiles }));
    if (losses.unpushed === true) lines.push(t('overview.losses.unpushed'));
    else if (losses.unpushed === null) lines.push(t('overview.losses.unknown'));
    return lines;
  };

  const removeWithLosses = async (row: OverviewCleanupRow) => {
    const confirmed = await confirm({
      title: t('overview.removeRisky.title', { name: worktreeName(row.facts) }),
      message: [t('overview.removeRisky.message'), ...lossLines(row.losses).map((line) => `• ${line}`)].join('\n'),
      action: t('overview.action.remove'),
      destructive: true,
    });
    if (confirmed) await removeWorktree(row.facts, row.losses);
  };

  const removalTooltip = (target: OverviewWorktreeTarget) => {
    const count = data.sessionsIn(target.worktree.path).length;
    const name = worktreeName(target);
    if (count === 0) return t('overview.action.removeHintNoSessions', { name });
    return count === 1 ? t('overview.action.removeHintOne', { name }) : t('overview.action.removeHintMany', { name, count });
  };

  const openButton = (session: Session, label = t('overview.action.open')) => (
    <Button size="xs" variant="ghost" onClick={() => openSession(session)}>{label}</Button>
  );

  const doneButton = (session: Session) => (
    <Button size="xs" variant="ghost" disabled={pending.has(session.id)} onClick={() => void markDone([session])}>
      {t('overview.action.done')}
    </Button>
  );

  const removeButton = (target: OverviewWorktreeTarget, onClick: () => void, variant: 'outline' | 'ghost' = 'outline') => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="xs" variant={variant} disabled={pending.has(target.worktree.path)} onClick={onClick}>
          {t('overview.action.remove')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">{removalTooltip(target)}</TooltipContent>
    </Tooltip>
  );

  const bulkDone = async () => {
    const items = sections.done.map((row) => ({ key: row.session.id, title: titleOf(row.session), reason: t(SIGNAL_KEY[row.signal]) }));
    const leftOut = data.leftOut.map((row) => ({ key: row.session.id, title: titleOf(row.session), reason: row.veto ? t(VETO_KEY[row.veto]) : '' }));
    const confirmed = await ask({
      title: items.length === 1 ? t('overview.bulkDone.titleOne') : t('overview.bulkDone.titleMany', { count: items.length }),
      description: t('overview.bulkDone.description'),
      action: t('overview.action.done'),
      items,
      leftOut,
    });
    if (confirmed) await markDone(sections.done.map((row) => row.session));
  };

  const cleanupReason = (row: OverviewCleanupRow) => (isNothingLost(row.losses)
    ? t(row.kind === 'merged' ? 'overview.cleanup.merged' : 'overview.cleanup.stale')
    : listFormat.format(lossLines(row.losses)));

  const safeCleanup = data.cleanup.filter((row) => isNothingLost(row.losses));
  const bulkRemove = async () => {
    const asItem = (row: OverviewCleanupRow) => ({ key: row.facts.worktree.path, title: worktreeName(row.facts), reason: cleanupReason(row) });
    const confirmed = await ask({
      title: safeCleanup.length === 1 ? t('overview.bulkRemove.titleOne') : t('overview.bulkRemove.titleMany', { count: safeCleanup.length }),
      description: t('overview.bulkRemove.description'),
      action: t('overview.action.remove'),
      items: safeCleanup.map(asItem),
      leftOut: data.cleanup.filter((row) => !isNothingLost(row.losses)).map(asItem),
    });
    if (!confirmed) return;
    // Every row waits for its turn as pending, so a second click cannot race the loop.
    await run(safeCleanup.map((row) => row.facts.worktree.path), async () => {
      for (const row of safeCleanup) await removeOne(row.facts, row.losses);
    });
    data.refreshGit();
  };

  if (!data.ready) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground typography-ui-label">
        {t('sessions.sidebar.group.empty.loadingSessions')}
      </div>
    );
  }

  const waitingCount = sections.waiting.length;
  const workingCount = sections.working.length + sections.stalled.length;
  const groups = groupByProject(data, sections);
  const groupOpen = (group: ProjectGroup) => groups.length === 1 || openProjects.has(group.label);
  const toggleGroup = (label: string) => setOpenProjects((current) => {
    const next = new Set(current);
    if (!next.delete(label)) next.add(label);
    return next;
  });

  // The line of counts at the top: the same facts as the sections, readable in
  // one glance, each a jump to its section. Nothing counted is hidden below.
  type CountEntry = { id: SectionId; count: number; one: I18nKey; many: I18nKey; color: string };
  const counts = ([
    { id: 'waiting', count: waitingCount, one: 'overview.count.waitingOne', many: 'overview.count.waitingMany', color: 'var(--status-error)' },
    { id: 'running', count: sections.running.length, one: 'overview.count.runningOne', many: 'overview.count.runningMany', color: 'var(--status-info)' },
    { id: 'done', count: sections.done.length, one: 'overview.count.doneOne', many: 'overview.count.doneMany', color: 'var(--pr-merged)' },
    { id: 'working', count: workingCount, one: 'overview.count.workingOne', many: 'overview.count.workingMany', color: 'var(--muted-foreground)' },
    { id: 'cleanup', count: data.cleanup.length, one: 'overview.count.cleanupOne', many: 'overview.count.cleanupMany', color: 'var(--muted-foreground)' },
  ] satisfies CountEntry[]).filter((entry) => entry.count > 0);
  const jumpTo = (id: SectionId) => sectionRefs.current.get(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const sectionRef = (id: SectionId) => (node: HTMLElement | null) => {
    if (node) sectionRefs.current.set(id, node);
    else sectionRefs.current.delete(id);
  };

  // Each section draws a hairline above it, except the first one shown.
  const shown: React.ReactNode[] = [];
  const add = (render: (divider: boolean) => React.ReactNode) => shown.push(render(shown.length > 0));

  if (waitingCount > 0 || reviews.items.length > 0) add((divider) => (
    <Section key="waiting" ref={sectionRef('waiting')} divider={divider} label={t('overview.section.waiting')} count={String(waitingCount)}>
      {sections.waiting.map((row) => {
        const asks = row.reason === 'permission' || row.reason === 'question';
        return (
          <OverviewRow
            key={row.session.id}
            layout={layout}
            mark={row.reason === 'finished'
              ? <SessionActivityIndicator state="unread" tooltip />
              : <RowMark mark={WAITING_MARK[row.reason]} label={t(WAITING_KEY[row.reason])} />}
            strong
            title={titleOf(row.session)}
            note={NAMED_WAITING.has(row.reason) ? t(WAITING_KEY[row.reason]) : null}
            noteColor={asks ? undefined : WAITING_MARK[row.reason].color}
            sub={row.reason === 'question' ? askedOf(row.session) : row.reason === 'finished' ? recapOf(row.session) : null}
            end={endOf(row.session)}
            actions={(
              <>
                {row.pr?.url ? (
                  <Button size="xs" variant="ghost" onClick={(event) => openTrackerItem(row.pr?.url ?? '', resolveGlobalSessionDirectory(row.session), event)}>
                    {t('overview.action.openPr')}
                  </Button>
                ) : null}
                {openButton(row.session, asks ? t('overview.action.answer') : undefined)}
              </>
            )}
            onOpen={() => openSession(row.session)}
          />
        );
      })}
      {reviews.items.length > 0 ? (
        <>
          <OverviewRow
            layout={layout}
            mark={<Icon name="git-pull-request" className="size-3 text-muted-foreground" />}
            plain
            title={t('overview.reviews.summary', { count: reviews.hasMore ? `${reviews.items.length}+` : String(reviews.items.length) })}
            end={<Icon name="arrow-right-s" className={cn('size-4 transition-transform', reviewsOpen && 'rotate-90 rtl:-rotate-90')} />}
            onOpen={() => setReviewsOpen((value) => !value)}
          />
          {reviewsOpen ? reviews.items.map((request) => (
            <OverviewRow
              key={request.url}
              layout={layout}
              title={request.title}
              end={`${request.repo} #${request.number}`}
              onOpen={(event) => openTrackerItem(request.url, request.directory, event)}
            />
          )) : null}
        </>
      ) : null}
    </Section>
  ));

  if (sections.running.length > 0) add((divider) => (
    <Section key="running" ref={sectionRef('running')} divider={divider} label={t('overview.section.running')} count={String(sections.running.length)}>
      {sections.running.map((row) => (
        <OverviewRow
          key={row.session.id}
          layout={layout}
          mark={<SessionActivityIndicator state={row.activity} tooltip />}
          title={titleOf(row.session)}
          note={t(ACTIVITY_KEY[row.activity])}
          end={endOf(row.session, <SessionActivityDuration sessionId={row.session.id} running />)}
          actions={openButton(row.session)}
          onOpen={() => openSession(row.session)}
        />
      ))}
    </Section>
  ));

  if (sections.done.length > 0) add((divider) => (
    <Section
      key="done"
      ref={sectionRef('done')}
      divider={divider}
      label={t('overview.section.done')}
      count={String(sections.done.length)}
      action={sections.done.length > 1 ? (
        <Button size="xs" variant="outline" onClick={() => void bulkDone()}>{t('overview.action.doneAll')}</Button>
      ) : null}
    >
      {sections.done.map((row) => {
        const target = removalTarget(data, row.session);
        return (
          <OverviewRow
            key={row.session.id}
            layout={layout}
            mark={<RowMark mark={SIGNAL_MARK[row.signal]} label={t(SIGNAL_KEY[row.signal])} />}
            title={titleOf(row.session)}
            note={t(SIGNAL_KEY[row.signal])}
            noteColor={SIGNAL_MARK[row.signal].color}
            sub={recapOf(row.session)}
            end={endOf(row.session)}
            actions={(
              <>
                {doneButton(row.session)}
                {target ? removeButton(target, () => void removeWorktree(target, { uncommittedFiles: 0, unpushed: false })) : null}
              </>
            )}
            onOpen={() => openSession(row.session)}
          />
        );
      })}
    </Section>
  ));

  const workingRow = (row: WorkingRow, project: boolean) => (
    <OverviewRow
      key={row.session.id}
      layout={layout}
      title={titleOf(row.session)}
      plain
      note={row.veto ? t(VETO_KEY[row.veto]) : row.stalled ? t('overview.row.stalled') : null}
      noteColor={row.veto ? 'var(--status-warning)' : undefined}
      end={endOf(row.session, undefined, project)}
      actions={doneButton(row.session)}
      onOpen={() => openSession(row.session)}
    />
  );

  // In work is context, not a task: one line per project with its counts,
  // the sessions underneath when opened. One project lists them straight away.
  if (workingCount > 0) add((divider) => (
    <Section key="working" ref={sectionRef('working')} divider={divider} label={t('overview.section.working')} count={String(workingCount)}>
      {groups.map((group) => {
        const open = groupOpen(group);
        const stats = [
          group.rows.length === 1 ? t('overview.count.workingOne') : t('overview.count.workingMany', { count: group.rows.length }),
          ...(group.stalled > 0 ? [group.stalled === 1 ? t('overview.count.stalledOne') : t('overview.count.stalledMany', { count: group.stalled })] : []),
        ];
        return (
          <div key={group.label} className="flex flex-col">
            {groups.length > 1 ? (
              <OverviewRow
                layout={layout}
                mark={<Icon name="arrow-right-s" className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90 rtl:-rotate-90')} />}
                title={group.label}
                end={<span className="flex items-center gap-3">{stats.map((stat) => <span key={stat}>{stat}</span>)}</span>}
                onOpen={() => toggleGroup(group.label)}
              />
            ) : null}
            {open ? <div className={cn('flex flex-col', groups.length > 1 && 'ps-6')}>{group.rows.map((row) => workingRow(row, false))}</div> : null}
          </div>
        );
      })}
    </Section>
  ));

  if (data.cleanup.length > 0) add((divider) => (
    <Section
      key="cleanup"
      ref={sectionRef('cleanup')}
      divider={divider}
      label={t('overview.section.cleanup')}
      count={String(data.cleanup.length)}
      action={safeCleanup.length > 1 ? (
        <Button size="xs" variant="outline" onClick={() => void bulkRemove()}>{t('overview.action.removeAllCount', { count: safeCleanup.length })}</Button>
      ) : null}
    >
      {data.cleanup.map((row) => {
        const safe = isNothingLost(row.losses);
        return (
          <OverviewRow
            key={row.facts.worktree.path}
            layout={layout}
            mark={<Icon name="git-branch" className="size-3 text-muted-foreground" />}
            plain
            title={worktreeName(row.facts)}
            note={cleanupReason(row)}
            noteColor={safe ? (row.kind === 'merged' ? 'var(--pr-merged)' : undefined) : 'var(--status-warning)'}
            end={row.facts.project.path.split('/').pop()}
            actions={removeButton(row.facts, () => void (safe ? removeWorktree(row.facts, row.losses) : removeWithLosses(row)), 'ghost')}
          />
        );
      })}
    </Section>
  ));

  return (
    <div className="h-full overflow-y-auto" style={mobile ? { paddingBottom: 'calc(1rem + var(--oc-safe-area-bottom, 0px))' } : undefined}>
      <div className={cn('mx-auto flex w-full flex-col', mobile ? 'gap-5 px-2 pt-4' : 'max-w-[52rem] gap-6 px-8 py-8')}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-2">
          {counts.length === 0 ? (
            <span className="typography-ui-label text-foreground">{t('overview.count.calm')}</span>
          ) : counts.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => jumpTo(entry.id)}
              className="inline-flex items-center gap-1.5 typography-ui-label text-foreground/80 hover:text-foreground"
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="tabular-nums">{entry.count === 1 ? t(entry.one) : t(entry.many, { count: entry.count })}</span>
            </button>
          ))}
        </div>
        {shown}
      </div>
      {confirmDialog}
      {bulkDialog}
    </div>
  );
}

/** A worktree by its branch, which is what the user named it for; the folder name when it has none. */
const worktreeName = (target: OverviewWorktreeTarget): string => target.worktree.branch?.trim() || getWorktreeDisplayName(target.worktree);

/** The desktop page in the main area; leaving it is choosing a session, or the sidebar button again. */
export function OverviewView(): React.ReactNode {
  const open = useUIStore((state) => state.isOverviewOpen);
  const leave = React.useCallback(() => useUIStore.getState().setOverviewOpen(false), []);
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-10 bg-background">
      <OverviewPage layout="page" onLeave={leave} />
    </div>
  );
}
