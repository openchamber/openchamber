import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { ACTIVITY_TITLE_KEY, isBuiltinActivityKey } from '@/components/session/sidebar/sessionSidebarActivityLabels';
import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatProjectLabel } from '@/components/session/sidebar/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { MobileProjectIcon } from '../MobileProjectIcon';
import { MobileSwipeActionsRow, ROW_ACTION_SLOT_WIDTH } from '../MobileSessionSwipe';
import type { MobileTreeGeometry } from './mobileSidebarGeometry';
import { useMobileRowSwipe, useMobileSidebarActions, useMobileSidebarRowsStore } from './mobileSidebarState';
import { MobileSwipeAction } from './mobileRowParts';
import { MobileRowMenu } from './MobileRowMenu';

const SECTION_HEADER_CLASS = 'flex min-h-10 min-w-0 flex-1 items-center gap-1.5 ps-2 pe-3 py-1.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

const putAwayRevealed = (): boolean => {
  const rows = useMobileSidebarRowsStore.getState();
  if (!rows.revealedKey) return false;
  rows.setRevealed(rows.revealedKey, false);
  return true;
};

const MobileCaption: React.FC<{
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ label, collapsed, onToggle }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={cn(SECTION_HEADER_CLASS, 'w-full gap-1')}
      onClick={() => {
        if (!putAwayRevealed()) onToggle();
      }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('sessions.sidebar.group.expandAria', { label }) : t('sessions.sidebar.group.collapseAria', { label })}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="min-w-0 truncate typography-ui-label font-medium text-muted-foreground">{label}</span>
      <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
};

export const MobileZoneHeader: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'activity-header' }>;
  onToggle: () => void;
}> = ({ row, onToggle }) => {
  const { t } = useI18n();
  return <MobileCaption label={row.label ?? (isBuiltinActivityKey(row.activityKey) ? t(ACTIVITY_TITLE_KEY[row.activityKey]) : '')} collapsed={row.collapsed} onToggle={onToggle} />;
};

export const MobileProjectsCaption: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'caption' }>;
  onToggle: () => void;
}> = ({ row, onToggle }) => {
  const { t } = useI18n();
  return <MobileCaption label={row.label ?? t('sessions.sidebar.activity.projectsTitle')} collapsed={row.collapsed} onToggle={onToggle} />;
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

export const MobileProjectHeader: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'project-header' }>;
  label: string;
  isRepo: boolean;
  active: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewLead: () => void;
  onRemove: () => void;
}> = ({ row, label, isRepo, active, onToggle, onNewSession, onNewLead, onRemove }) => {
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
            if (!putAwayRevealed()) onToggle();
          }}
          aria-expanded={!row.collapsed}
          aria-label={row.collapsed ? t('sessions.sidebar.group.expandAria', { label }) : t('sessions.sidebar.group.collapseAria', { label })}
          style={{ touchAction: 'manipulation' }}
        >
          <MobileProjectIcon project={project} size="xs" />
          <span className="block min-w-0 flex-1 truncate ps-1 typography-ui-label font-medium text-foreground">{label}</span>
        </button>
        {isRepo ? <HeaderIconButton icon="git-branch" label={t('sessions.sidebar.project.actions.newWorktree')} onClick={() => actions.openNewWorktree(project.id)} /> : null}
        <MobileRowMenu menu={<>
          <ContextMenuItem onClick={onNewSession}>
            <Icon name="add" className="me-1 size-4" />
            {t('sessions.sidebar.project.actions.newSession')}
          </ContextMenuItem>
          <ContextMenuItem onClick={onNewLead}>
            <Icon name="lead-flag" className="me-1 size-4" />
            {t('sessions.sidebar.project.actions.newLead')}
          </ContextMenuItem>
        </>}>
          <HeaderIconButton icon="add" label={t('mobile.sessions.newSessionInProjectAria', { label })} onClick={onNewSession} />
        </MobileRowMenu>
      </div>
    </MobileSwipeActionsRow>
  );
};

export const MobileGroupHeader: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'group-header' }>;
  geometry: MobileTreeGeometry;
  onToggle: (groupKey: string) => void;
}> = ({ row, geometry, onToggle }) => {
  const { t } = useI18n();
  const label = row.group.label;
  const expanded = !row.collapsed;
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-0.5 py-1 pe-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => {
        if (!putAwayRevealed() && !row.empty) onToggle(row.groupKey);
      }}
      aria-expanded={row.empty ? undefined : expanded}
      aria-label={row.empty ? label : expanded ? t('sessions.sidebar.group.collapseAria', { label }) : t('sessions.sidebar.group.expandAria', { label })}
      style={{ paddingInlineStart: geometry.slotLeft(row.depth), touchAction: 'manipulation' }}
    >
      {row.empty ? <span aria-hidden className="size-3.5 shrink-0" /> : <FileTreeChevron expanded={expanded} />}
      <Icon name="folder" className="mx-px size-3 shrink-0 text-muted-foreground" />
      <span className="block min-w-0 flex-1 truncate typography-ui-label font-medium oc-group-label">{label}</span>
    </button>
  );
};

export const MobileFolderRow: React.FC<{
  row: Extract<SessionSidebarRow, { kind: 'folder-header' }>;
  geometry: MobileTreeGeometry;
}> = ({ row, geometry }) => {
  const { t } = useI18n();
  const expanded = !row.collapsed;
  const project = useProjectsStore((state) => (row.mixed ? state.projects.find((entry) => entry.id === row.projectId) : undefined));
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-0.5 py-1 pe-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => {
        if (!putAwayRevealed() && !row.empty) useSessionFoldersStore.getState().toggleFolderCollapse(row.folder.id);
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
      {project ? <span className="min-w-0 shrink-[2] truncate typography-micro text-muted-foreground">{formatProjectLabel(project.label?.trim() || project.path)}</span> : null}
    </button>
  );
};

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
