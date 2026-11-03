import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ACTIVITY_TITLE_KEY, isBuiltinActivityKey } from '@/components/session/sidebar/sessionSidebarActivityLabels';
import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { MobileProjectIcon } from '../MobileProjectIcon';
import { MobileSwipeActionsRow, ROW_ACTION_SLOT_WIDTH } from '../MobileSessionSwipe';
import type { MobileTreeGeometry } from './mobileSidebarGeometry';
import { useMobileRowSwipe, useMobileSidebarActions, useMobileSidebarRowsStore } from './mobileSidebarState';
import { MobileSwipeAction } from './mobileRowParts';

// A header starts on the rows' 14px slot (8px in), as the desktop's do: a
// caption's word there, a project's icon in the slot with its label where
// the rows' titles start. 40px tall for a thumb.
const SECTION_HEADER_CLASS = 'flex min-h-10 min-w-0 flex-1 items-center gap-1.5 ps-2 pe-3 py-1.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/** A tap on a header while a row has its actions out only puts them away. */
const putAwayRevealed = (): boolean => {
  const rows = useMobileSidebarRowsStore.getState();
  if (!rows.revealedKey) return false;
  rows.setRevealed(rows.revealedKey, false);
  return true;
};

/**
 * A section's caption, as the desktop's: a bare muted word at the rows' size,
 * with the chevron after it. The chevron always shows, as a phone has no
 * hover to reveal it.
 */
const MobileCaption: React.FC<{
  label: string;
  collapsed: boolean;
  forceExpanded: boolean;
  onToggle: () => void;
}> = ({ label, collapsed, forceExpanded, onToggle }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={cn(SECTION_HEADER_CLASS, 'w-full gap-1')}
      disabled={forceExpanded}
      onClick={() => {
        if (!putAwayRevealed()) onToggle();
      }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('sessions.sidebar.group.expandAria', { label }) : t('sessions.sidebar.group.collapseAria', { label })}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="min-w-0 truncate typography-ui-label font-medium text-muted-foreground">{label}</span>
      {forceExpanded ? null : <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4 shrink-0 text-muted-foreground" />}
    </button>
  );
};

/** Chats, Pinned, In work or the list by time. */
export const MobileZoneHeader: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'activity-header' }>;
  onToggle: () => void;
}> = ({ row, onToggle }) => {
  const { t } = useI18n();
  return <MobileCaption label={row.label ?? (isBuiltinActivityKey(row.activityKey) ? t(ACTIVITY_TITLE_KEY[row.activityKey]) : '')} collapsed={row.collapsed} forceExpanded={row.forceExpanded} onToggle={onToggle} />;
};

/** The caption over the projects: closed, it folds every project away. */
export const MobileProjectsCaption: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'caption' }>;
  onToggle: () => void;
}> = ({ row, onToggle }) => {
  const { t } = useI18n();
  return <MobileCaption label={row.label ?? t('sessions.sidebar.activity.projectsTitle')} collapsed={row.collapsed} forceExpanded={row.forceExpanded} onToggle={onToggle} />;
};

const HeaderIconButton: React.FC<{ icon: 'add' | 'git-branch'; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
  <button
    type="button"
    className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={label}
    title={label}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    style={{ touchAction: 'manipulation' }}
  >
    <Icon name={icon} className={icon === 'add' ? 'size-4' : 'size-3.5'} />
  </button>
);

/**
 * A project's header: a tap folds it, the buttons start a worktree or a
 * session there, and swiping reveals Remove (two taps) and Edit.
 */
export const MobileProjectHeader: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'project-header' }>;
  label: string;
  isRepo: boolean;
  active: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onRemove: () => void;
}> = ({ row, label, isRepo, active, onToggle, onNewSession, onRemove }) => {
  const { t } = useI18n();
  const actions = useMobileSidebarActions();
  const project = row.section.project;
  const { revealed, armed } = useMobileRowSwipe(row.key);
  const setRevealed = (next: boolean) => useMobileSidebarRowsStore.getState().setRevealed(row.key, next);
  return (
    <MobileSwipeActionsRow
      actionsWidth={2 * ROW_ACTION_SLOT_WIDTH}
      revealed={revealed}
      onRevealedChange={setRevealed}
      actions={<>
        <MobileSwipeAction
          icon="delete-bin"
          tone="destructive"
          armed={armed}
          label={armed ? t('mobile.sessions.confirmRemoveProjectAria', { label }) : t('mobile.sessions.removeProjectAria', { label })}
          revealed={revealed}
          onClick={() => {
            if (!armed) {
              useMobileSidebarRowsStore.getState().arm(row.key);
              return;
            }
            setRevealed(false);
            onRemove();
            toast.success(t('mobile.sessions.toast.projectRemoved', { label }));
          }}
        />
        <MobileSwipeAction
          icon="edit"
          label={t('mobile.sessions.editProjectAria', { label })}
          revealed={revealed}
          onClick={() => {
            setRevealed(false);
            actions.openProjectEdit(project.id);
          }}
        />
      </>}
    >
      <div data-active-project={active || undefined} className="flex min-h-10 w-full items-center">
        <button
          type="button"
          className={SECTION_HEADER_CLASS}
          onClick={() => {
            if (!putAwayRevealed() && !row.forceExpanded) onToggle();
          }}
          aria-expanded={!row.collapsed}
          aria-label={row.collapsed ? t('sessions.sidebar.group.expandAria', { label }) : t('sessions.sidebar.group.collapseAria', { label })}
          style={{ touchAction: 'manipulation' }}
        >
          {/* As on the desktop: the icon in the rows' slot, the label at the
              rows' size and medium weight where their titles start. */}
          <MobileProjectIcon project={project} size="xs" />
          <span className="block min-w-0 flex-1 truncate ps-1 typography-ui-label font-medium text-foreground">{label}</span>
        </button>
        {isRepo ? <HeaderIconButton icon="git-branch" label={t('sessions.sidebar.project.actions.newWorktree')} onClick={() => actions.openNewWorktree(project.id)} /> : null}
        {/* Its edge on the drawer's gutter, as the header's New chat. */}
        <HeaderIconButton icon="add" label={t('mobile.sessions.newSessionInProjectAria', { label })} onClick={onNewSession} />
      </div>
    </MobileSwipeActionsRow>
  );
};

/** A group that is not a work of its own: the archive bucket of a project. */
export const MobileGroupHeader: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'group-header' }>;
  geometry: MobileTreeGeometry;
  onToggle: (groupKey: string) => void;
}> = ({ row, geometry, onToggle }) => {
  const { t } = useI18n();
  const label = row.group.label;
  const expanded = row.forceExpanded || !row.collapsed;
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-0.5 py-1 pe-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => {
        if (!putAwayRevealed() && !row.empty && !row.forceExpanded) onToggle(row.groupKey);
      }}
      aria-expanded={row.empty ? undefined : expanded}
      aria-label={row.empty ? label : expanded ? t('sessions.sidebar.group.collapseAria', { label }) : t('sessions.sidebar.group.expandAria', { label })}
      style={{ paddingInlineStart: geometry.slotLeft(row.depth), touchAction: 'manipulation' }}
    >
      {row.empty ? <span aria-hidden className="size-3.5 shrink-0" /> : <FileTreeChevron expanded={expanded} />}
      <Icon name="folder" className="mx-px size-3 shrink-0 text-muted-foreground" />
      {/* A step below full strength, as on the desktop sidebar. */}
      <span className="block min-w-0 flex-1 truncate typography-ui-label font-medium oc-group-label">{label}</span>
    </button>
  );
};

/** A chat folder, shown and folded here; the phone does not change folders. */
export const MobileFolderRow: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'folder-header' }>;
  geometry: MobileTreeGeometry;
}> = ({ row, geometry }) => {
  const { t } = useI18n();
  const expanded = row.forceExpanded || !row.collapsed;
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-0.5 py-1 pe-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => {
        if (!putAwayRevealed() && !row.empty && !row.forceExpanded) useSessionFoldersStore.getState().toggleFolderCollapse(row.folder.id);
      }}
      aria-expanded={row.empty ? undefined : expanded}
      aria-label={row.empty
        ? row.displayName
        : expanded
          ? t('sessions.sidebar.folderItem.collapseAria', { folderName: row.displayName })
          : t('sessions.sidebar.folderItem.expandAria', { folderName: row.displayName })}
      style={{ paddingInlineStart: geometry.slotLeft(row.depth), touchAction: 'manipulation' }}
    >
      {row.empty ? <span aria-hidden className="size-3.5 shrink-0" /> : <FileTreeChevron expanded={expanded} />}
      <Icon name={expanded && !row.empty ? 'folder-open' : 'folder'} className="mx-px size-3 shrink-0 text-muted-foreground" />
      <span className="block min-w-0 flex-1 truncate typography-ui-label font-medium oc-group-label">{row.displayName}</span>
    </button>
  );
};

/** A group still loading, or one that failed, with Retry and access where they help. */
export const MobileStatusRow: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'status' }>;
  indent: number;
  onRetry: () => void;
  onGrantAccess: () => void;
}> = ({ row, indent, onRetry, onGrantAccess }) => {
  const { t } = useI18n();
  const label = row.status.state === 'permission-denied'
    ? t('sessions.sidebar.group.empty.permissionDenied')
    : row.status.state === 'load-failed'
      ? t('sessions.sidebar.group.empty.loadFailed')
      : row.status.state === 'initialization-failed'
        ? t('sessions.sidebar.group.empty.initializationFailed')
        : t('sessions.sidebar.group.empty.loadingSessions');
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2 py-1 pe-3 typography-micro text-muted-foreground" style={{ paddingInlineStart: indent }}>
      {row.status.state === 'loading' ? <Spinner className="size-3" /> : null}
      <span>{label}</span>
      {row.status.canGrantAccess ? <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={onGrantAccess}>{t('sessions.sidebar.group.empty.grantAccess')}</Button> : null}
      {row.status.state !== 'loading' ? <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={onRetry}>{t('sessions.sidebar.group.empty.retry')}</Button> : null}
    </div>
  );
};
