import React from 'react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { CollapsedActivityIndicator } from '@/components/session/sidebar/sessions/collapsedActivityIndicator';
import { useCollapsedSessionActivityState } from '@/components/session/sidebar/sessions/collapsedActivityState';
import { DirectoryActionIndicator } from '@/components/session/sidebar/sessions/DirectoryActionIndicator';
import { useRunWork } from '@/components/session/sidebar/sessions/useRunWork';
import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import { useSessionDraftRow } from '@/components/session/sidebar/works/useSessionDraftRow';
import { useWorktreeWork } from '@/components/session/sidebar/works/useWorktreeWork';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useI18n } from '@/lib/i18n';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { MobileProjectIcon } from '../MobileProjectIcon';
import { MobileRunProviderLogos } from '../MobileRunProviderLogos';
import { MobileSessionRenameForm } from '../MobileSessionRenameForm';
import { MobileSwipeActionsRow, ROW_ACTION_SLOT_WIDTH } from '../MobileSessionSwipe';
import type { MobileTreeGeometry } from './mobileSidebarGeometry';
import { useMobileRowSwipe, useMobileSidebarActions, useMobileSidebarRowsStore } from './mobileSidebarState';
import { MOBILE_ACTIVE_ROW_CLASS, MOBILE_ACTIVE_TITLE_CLASS, MobileRowChevron, MobileSlotChevron, MobileSwipeAction, MobileTwoLineLayout } from './mobileRowParts';

const ONE_LINE_ROW_CLASS = 'flex h-9 min-w-0 flex-1 items-center gap-2.5 pe-3.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/** The project of a row listed among other projects' works, for the icon that names it. */
const useMixedRowProject = (projectId: string | null, shown: boolean) => useProjectsStore(React.useCallback(
  (state) => (shown && projectId ? state.projects.find((entry) => entry.id === projectId) ?? null : null),
  [projectId, shown],
));

/** A row's state or mark in the slot left of its title, where the chevron is not. */
const MobileSlotMark: React.FC<{ slotLeft: number; children: React.ReactNode }> = ({ slotLeft, children }) => (
  <span className="pointer-events-none absolute inset-y-0 z-10 flex w-3.5 items-center justify-center" style={{ insetInlineStart: slotLeft }}>
    {children}
  </span>
);

/**
 * A worktree work in the phone's list: one row for the worktree and every
 * session in it, as on the desktop. A tap opens what was last worked on
 * there; the chevron opens its sessions. Swiping reveals Done or Track,
 * Rename, Archive worktree and Delete.
 */
export const MobileWorktreeRow: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'group-header' }>;
  geometry: MobileTreeGeometry;
  onToggle: (groupKey: string) => void;
}> = ({ row, geometry, onToggle }) => {
  const { t } = useI18n();
  const actions = useMobileSidebarActions();
  const { revealed, renaming } = useMobileRowSwipe(row.key);
  const work = useWorktreeWork({ group: row.group, projectId: row.projectId, collapsed: row.collapsed, onNavigate: actions.close });
  const { worktree, project, refs, label, branch, title, inWork, selected, finishing, worktreeRemoving, activityState } = work;
  const mixedProject = useMixedRowProject(row.projectId, row.mixed && row.detailed);
  const expandable = !row.empty;
  const expanded = row.forceExpanded || !row.collapsed;
  const toggle = expandable && !row.forceExpanded ? () => onToggle(row.groupKey) : undefined;
  const setRevealed = (next: boolean) => useMobileSidebarRowsStore.getState().setRevealed(row.key, next);
  const after = (action: () => void) => () => {
    setRevealed(false);
    action();
  };
  const select = () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    work.open();
  };
  const stopRename = () => useMobileSidebarRowsStore.getState().stopRename();
  const stateMark = worktreeRemoving || finishing
    ? <Spinner className="size-3.5" />
    : activityState ? <CollapsedActivityIndicator state={activityState} /> : null;
  const branchMark = (
    <Icon
      name="git-branch"
      className={cn('size-3.5 shrink-0', refs.prColor ? 'oc-ref-tint' : 'text-muted-foreground')}
      style={refs.prColor ? refTintStyle(refs.prColor) : undefined}
      aria-hidden={false}
      role="img"
      aria-label={t('sessions.sidebar.work.worktreeMark')}
    />
  );
  const duration = work.durationSessionId
    ? <SessionActivityDuration sessionId={work.durationSessionId} running={Boolean(work.runningSessionId)} className="shrink-0 typography-micro" />
    : null;
  const refMark = refs.prSummary
    ? { icon: 'git-pull-request' as const, color: refs.prColor, text: refs.prReference }
    : refs.primaryIssue ? { icon: refs.primaryIssue.icon, color: refs.primaryIssue.color, text: refs.primaryIssue.label } : null;
  const ref = refMark ? (
    <span
      className={cn('inline-flex shrink-0 items-center gap-0.5 typography-micro', refMark.color ? 'oc-ref-tint' : 'text-muted-foreground')}
      style={refMark.color ? refTintStyle(refMark.color) : undefined}
    >
      <Icon name={refMark.icon} className="size-3" />
      {row.detailed && refMark.text ? <span className="leading-none tabular-nums">{refMark.text}</span> : null}
    </span>
  ) : null;
  const titleText = (
    <span
      dir="auto"
      className={cn(
        'block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label',
        // The title carries the state as a session's does.
        selected
          ? MOBILE_ACTIVE_TITLE_CLASS
          : activityState === 'unread' || activityState === 'permission' || activityState === 'form'
            ? 'font-semibold text-foreground'
            : activityState === 'active' ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
  const renameForm = (indent: number, className?: string) => (
    <MobileSessionRenameForm
      initialTitle={title ?? ''}
      indent={indent}
      className={className}
      placeholder={branch ?? t('sessions.sidebar.work.rename.placeholder')}
      onSubmit={(next) => {
        stopRename();
        void work.saveTitle(next);
      }}
      onCancel={stopRename}
    />
  );
  const missing = worktree?.worktreeStatus === 'missing' ? (
    <span className="inline-flex shrink-0 items-center text-status-warning" role="img" aria-label={t('sessions.sidebar.group.worktreeMissing')}>
      <Icon name="alert" className="size-3" />
    </span>
  ) : null;
  const directoryIndicator = row.group.directory ? <DirectoryActionIndicator directory={row.group.directory} /> : null;

  let content: React.ReactNode;
  if (row.detailed) {
    content = (
      <MobileTwoLineLayout
        indent={geometry.detailedLeft(row.depth)}
        onSelect={renaming ? undefined : select}
        ariaLabel={t('sessions.sidebar.work.openAria', { label })}
        chevron={toggle ? <MobileRowChevron expanded={expanded} kind="work" label={label} onToggle={toggle} /> : null}
        firstLine={renaming
          ? renameForm(0, 'h-[1lh] pe-0 typography-ui-label [&_button]:size-6 [&_button>svg]:size-3.5')
          : <>{titleText}{missing}{directoryIndicator}{stateMark}{duration}</>}
        secondLine={<>
          {mixedProject ? <MobileProjectIcon project={mixedProject} size="xs" /> : null}
          {branchMark}
          {branch && branch !== label ? <span className="block min-w-0 truncate typography-micro">{branch}</span> : null}
          <span className="ms-auto flex shrink-0 items-center">{ref}</span>
        </>}
      />
    );
  } else {
    content = <>
      {toggle
        ? <MobileSlotChevron slotLeft={geometry.slotLeft(row.depth)}><MobileRowChevron expanded={expanded} kind="work" label={label} onToggle={toggle} /></MobileSlotChevron>
        : <MobileSlotMark slotLeft={geometry.slotLeft(row.depth)}>{stateMark ?? branchMark}</MobileSlotMark>}
      {renaming ? renameForm(geometry.textLeft(row.depth)) : (
        <button
          type="button"
          className={ONE_LINE_ROW_CLASS}
          style={{ paddingInlineStart: geometry.textLeft(row.depth), touchAction: 'manipulation' }}
          aria-label={t('sessions.sidebar.work.openAria', { label })}
          onClick={select}
        >
          {titleText}
          {missing}
          {ref}
          {directoryIndicator}
          {toggle ? stateMark : null}
          {duration}
        </button>
      )}
    </>;
  }

  const slots = (work.workAction ? 1 : 0) + 1 + (work.canArchive ? 1 : 0) + (worktree && !worktreeRemoving ? 1 : 0);
  return (
    <MobileSwipeActionsRow
      actionsWidth={slots * ROW_ACTION_SLOT_WIDTH}
      revealed={revealed}
      onRevealedChange={setRevealed}
      dataActiveSession={selected}
      contentClassName={cn('relative flex w-full items-center bg-background transition-colors', selected && MOBILE_ACTIVE_ROW_CLASS, worktreeRemoving && 'opacity-60')}
      actions={<>
        {work.workAction ? (
          <MobileSwipeAction
            icon={inWork ? 'check' : 'eye'}
            tone={inWork ? 'success' : 'default'}
            label={inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
            revealed={revealed}
            disabled={finishing || worktreeRemoving}
            onClick={after(work.toggleWork)}
          />
        ) : null}
        <MobileSwipeAction
          icon="edit"
          label={t('sessions.sidebar.work.menu.rename')}
          revealed={revealed}
          onClick={() => useMobileSidebarRowsStore.getState().startRename(row.key)}
        />
        {work.canArchive ? (
          <MobileSwipeAction
            icon="archive"
            label={t('sessions.sidebar.work.menu.archive')}
            revealed={revealed}
            disabled={finishing}
            onClick={after(() => { void work.finish(true); })}
          />
        ) : null}
        {worktree && !worktreeRemoving ? (
          <MobileSwipeAction
            icon="delete-bin"
            tone="destructive"
            label={t('sessions.sidebar.group.actions.deleteWorktree')}
            revealed={revealed}
            onClick={after(() => {
              if (project) actions.requestWorktreeDelete({ id: project.id, path: project.path }, worktree);
            })}
          />
        ) : null}
      </>}
    >
      {content}
    </MobileSwipeActionsRow>
  );
};

/**
 * A multi-run in the phone's list, a work like a worktree: a tap opens its
 * newest fusion, else its overview; the chevron opens its lanes. Swiping
 * reveals Done or Track, Open overview, Rename and Archive run.
 */
export const MobileRunRow: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'run' }>;
  geometry: MobileTreeGeometry;
  toggleParent: (key: string) => void;
}> = ({ row, geometry, toggleParent }) => {
  const { t } = useI18n();
  const actions = useMobileSidebarActions();
  const { run } = row;
  const { revealed, renaming } = useMobileRowSwipe(row.key);
  const work = useRunWork(run, row.laneNodes, actions.close);
  const activityNodes = React.useMemo(() => [...row.laneNodes], [row.laneNodes]);
  const activityState = useCollapsedSessionActivityState({ nodes: activityNodes, blockingSessionIds: row.blockingSessionIds });
  const activity = activityState ? <CollapsedActivityIndicator state={activityState} /> : null;
  const mixedProject = useMixedRowProject(row.projectId, row.detailed && row.renderContext === 'timeline-mixed');
  const expanded = row.forceExpanded || row.expanded;
  const toggle = row.laneNodes.length > 0 && !row.forceExpanded ? () => toggleParent(row.expansionKey) : undefined;
  const laneCount = run.lanes.length;
  const setRevealed = (next: boolean) => useMobileSidebarRowsStore.getState().setRevealed(row.key, next);
  const after = (action: () => void) => () => {
    setRevealed(false);
    action();
  };
  const select = () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    work.open();
  };
  const stopRename = () => useMobileSidebarRowsStore.getState().stopRename();
  const runMark = <ArrowsMerge className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  const titleText = (
    // Muted like an idle session title; the run's state shows in its mark.
    <span dir="auto" className={cn('block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label', work.isActive ? MOBILE_ACTIVE_TITLE_CLASS : 'text-muted-foreground')}>
      {run.title}
    </span>
  );
  const renameForm = (indent: number, className?: string) => (
    <MobileSessionRenameForm
      initialTitle={run.title}
      indent={indent}
      className={className}
      onSubmit={(next) => {
        stopRename();
        void work.rename(next);
      }}
      onCancel={stopRename}
    />
  );
  const ariaLabel = t('sessions.sidebar.run.openOverviewAria', { title: run.title });

  let content: React.ReactNode;
  if (row.detailed) {
    content = (
      <MobileTwoLineLayout
        indent={geometry.detailedLeft(row.depth)}
        onSelect={renaming ? undefined : select}
        ariaLabel={ariaLabel}
        chevron={toggle ? <MobileRowChevron expanded={expanded} kind="run" label={run.title} onToggle={toggle} /> : null}
        firstLine={renaming
          ? renameForm(0, 'h-[1lh] pe-0 typography-ui-label [&_button]:size-6 [&_button>svg]:size-3.5')
          : <>{titleText}{activity}</>}
        secondLine={<>
          {mixedProject ? <MobileProjectIcon project={mixedProject} size="xs" /> : null}
          {runMark}
          <span className="block min-w-0 flex-1 truncate typography-micro">
            {laneCount === 1
              ? t('sessions.sidebar.run.laneCountSingle', { count: laneCount })
              : t('sessions.sidebar.run.laneCountPlural', { count: laneCount })}
          </span>
          <MobileRunProviderLogos providerIDs={run.providerIDs} />
        </>}
      />
    );
  } else {
    content = <>
      {toggle
        ? <MobileSlotChevron slotLeft={geometry.slotLeft(row.depth)}><MobileRowChevron expanded={expanded} kind="run" label={run.title} onToggle={toggle} /></MobileSlotChevron>
        : <MobileSlotMark slotLeft={geometry.slotLeft(row.depth)}>{activity ?? runMark}</MobileSlotMark>}
      {renaming ? renameForm(geometry.textLeft(row.depth)) : (
        <button
          type="button"
          className={ONE_LINE_ROW_CLASS}
          style={{ paddingInlineStart: geometry.textLeft(row.depth), touchAction: 'manipulation' }}
          aria-label={ariaLabel}
          onClick={select}
        >
          {titleText}
          <MobileRunProviderLogos providerIDs={run.providerIDs} />
          {toggle ? activity : null}
        </button>
      )}
    </>;
  }

  return (
    <MobileSwipeActionsRow
      actionsWidth={(work.sessionWorkEnabled ? 4 : 3) * ROW_ACTION_SLOT_WIDTH}
      revealed={revealed}
      onRevealedChange={setRevealed}
      dataActiveSession={work.isActive}
      contentClassName={cn('relative flex w-full items-center bg-background transition-colors', work.isActive && MOBILE_ACTIVE_ROW_CLASS)}
      actions={<>
        {work.sessionWorkEnabled ? (
          <MobileSwipeAction
            icon={work.inWork ? 'check' : 'eye'}
            tone={work.inWork ? 'success' : 'default'}
            label={work.inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
            revealed={revealed}
            disabled={work.busy}
            onClick={after(() => { void work.toggleWork(); })}
          />
        ) : null}
        <MobileSwipeAction icon="git-merge" glyph={<ArrowsMerge className="size-[18px]" aria-hidden="true" />} label={t('sessions.sidebar.run.menu.openOverview')} revealed={revealed} onClick={after(work.openOverview)} />
        <MobileSwipeAction icon="edit" label={t('multirun.overview.rename.aria')} revealed={revealed} onClick={() => useMobileSidebarRowsStore.getState().startRename(row.key)} />
        <MobileSwipeAction icon="archive" label={t('multirun.overview.archive.action')} revealed={revealed} disabled={work.busy} onClick={after(() => { void work.archive(); })} />
      </>}
    >
      {content}
    </MobileSwipeActionsRow>
  );
};

/**
 * A new session's draft not sent yet, where its session would go: a pen in
 * the slot and the start of what was typed. A tap opens it in the composer;
 * swiping reveals Discard, which throws it away without asking.
 */
export const MobileDraftRow: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'draft' }>;
  geometry: MobileTreeGeometry;
}> = ({ row, geometry }) => {
  const { t } = useI18n();
  const actions = useMobileSidebarActions();
  const { draft } = row;
  const { revealed } = useMobileRowSwipe(row.key);
  const { isOpen, firstLine, attachmentCount, label, open, discard } = useSessionDraftRow(draft, actions.close);
  const mixedProject = useMixedRowProject(draft.projectId ?? null, row.detailed && row.mixed);
  // Known once the directory's git status has been read; the line keeps its height without it.
  const branch = useGitBranchLabel(row.detailed ? draft.directory : null);
  const setRevealed = (next: boolean) => useMobileSidebarRowsStore.getState().setRevealed(row.key, next);
  const select = () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    open();
  };
  const pen = <Icon name="edit" className="size-3 shrink-0 text-muted-foreground" />;
  const attachment = firstLine && attachmentCount > 0 ? <Icon name="attachment-2" className="size-3 shrink-0 text-muted-foreground" /> : null;
  const titleText = (
    <span dir="auto" className={cn('block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label italic', isOpen ? MOBILE_ACTIVE_TITLE_CLASS : 'text-muted-foreground')}>
      {label}
    </span>
  );
  const ariaLabel = t('sessions.sidebar.draft.openAria', { label });

  return (
    <MobileSwipeActionsRow
      actionsWidth={ROW_ACTION_SLOT_WIDTH}
      revealed={revealed}
      onRevealedChange={setRevealed}
      dataActiveSession={isOpen}
      contentClassName={cn('relative flex w-full items-center bg-background transition-colors', isOpen && MOBILE_ACTIVE_ROW_CLASS)}
      actions={(
        <MobileSwipeAction
          icon="close"
          tone="destructive"
          label={t('sessions.sidebar.draft.discard')}
          revealed={revealed}
          onClick={() => {
            setRevealed(false);
            discard();
          }}
        />
      )}
    >
      {row.detailed ? (
        <MobileTwoLineLayout
          indent={geometry.detailedLeft(row.depth)}
          onSelect={select}
          ariaLabel={ariaLabel}
          chevron={null}
          firstLine={titleText}
          secondLine={<>
            {mixedProject ? <MobileProjectIcon project={mixedProject} size="xs" /> : null}
            {pen}
            {branch ? <span className="block min-w-0 truncate typography-micro">{branch}</span> : null}
            {attachment ? <span className="ms-auto flex shrink-0 items-center">{attachment}</span> : null}
          </>}
        />
      ) : <>
        <MobileSlotMark slotLeft={geometry.slotLeft(row.depth)}>{pen}</MobileSlotMark>
        <button
          type="button"
          className={ONE_LINE_ROW_CLASS}
          style={{ paddingInlineStart: geometry.textLeft(row.depth), touchAction: 'manipulation' }}
          aria-label={ariaLabel}
          onClick={select}
        >
          {titleText}
          {attachment}
        </button>
      </>}
    </MobileSwipeActionsRow>
  );
};
