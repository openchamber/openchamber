import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { QuickSessionAction } from './QuickSessionAction';
import { handleRowActionMouseDown, handleRowActionPointerDown } from './sessionRowActionEvents';
import type { resolveSessionRowActionLayout } from './sessionRowLayout';

type SessionRowActionsProps = {
  layout: ReturnType<typeof resolveSessionRowActionLayout>;
  session: Session;
  sessionTitle: string;
  archivedBucket: boolean;
  isCurrentSession: boolean;
  isTimelineRow: boolean;
  isOneLineTimelineRow: boolean;
  alwaysShowActions: boolean;
  isVSCode: boolean;
  isInWork: boolean;
  toggleWork: () => void;
  setOpenSidebarMenuKey: (key: string | null) => void;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  isMenuOpen: boolean;
  isSessionMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onMenuOpenChangeComplete: (open: boolean) => void;
  menuContent: React.ReactNode;
};

// external: https://base-ui.com/react/components/menu Trigger handlers record the opening event so a clicked menu stays open on pointer leave.
const handleMenuTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  event.stopPropagation();
};

const handleMenuTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
  event.stopPropagation();
};

const handleMenuTriggerMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
  event.stopPropagation();
};

export function SessionRowActions({
  layout,
  session,
  sessionTitle,
  archivedBucket,
  isCurrentSession,
  isTimelineRow,
  isOneLineTimelineRow,
  alwaysShowActions,
  isVSCode,
  isInWork,
  toggleWork,
  setOpenSidebarMenuKey,
  handleDeleteSession,
  isMenuOpen,
  isSessionMenuOpen,
  onMenuOpenChange,
  onMenuOpenChangeComplete,
  menuContent,
}: SessionRowActionsProps): React.ReactNode {
  const { t } = useI18n();
  const runtimeApis = React.useContext(RuntimeAPIContext);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const archiveShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('archive_current_session', shortcutOverrides), '');
  const {
    revealOnHoverClass,
    showWorkAction,
    showQuickArchiveAction,
    showOpenInEditorAction,
    actionButtonSizeClass,
    actionIconSizeClass,
    checkIconSizeClass,
  } = layout;
  const workActionLabel = isInWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track');

  const handleQuickArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket });
  };

  const handleQuickDeleteClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket, hardDelete: true, skipConfirm: true });
  };

  const handleOpenInEditorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void runtimeApis?.vscode?.executeCommand('openchamber.openSessionInEditor', session.id, sessionTitle);
  };

  const handleWorkToggleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    toggleWork();
  };

  return (
    <div className={cn(
      'absolute inset-e-1 z-10 flex items-center gap-0.5',
      isTimelineRow && !isOneLineTimelineRow ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2',
      isSessionMenuOpen
        ? 'opacity-100'
        : (alwaysShowActions && !isVSCode)
          ? 'opacity-100'
          : cn('opacity-0', revealOnHoverClass),
    )}>
      <TooltipProvider delayDuration={400}>
      {showWorkAction ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                actionButtonSizeClass,
                isInWork ? 'text-status-success' : 'text-muted-foreground hover:text-foreground',
              )}
              aria-label={workActionLabel}
              onPointerDown={handleRowActionPointerDown}
              onMouseDown={handleRowActionMouseDown}
              onClick={handleWorkToggleClick}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Icon name={isInWork ? 'check' : 'eye'} className={isInWork ? checkIconSizeClass : actionIconSizeClass} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {workActionLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showQuickArchiveAction ? (
        <QuickSessionAction
          archiveLabel={t('sessions.sidebar.bulkActions.archive')}
          shortcut={isCurrentSession ? archiveShortcut : undefined}
          deleteLabel={t('sessions.sidebar.bulkActions.delete')}
          buttonSizeClass={actionButtonSizeClass}
          iconSizeClass={actionIconSizeClass}
          onPointerDown={handleRowActionPointerDown}
          onMouseDown={handleRowActionMouseDown}
          onArchive={handleQuickArchiveClick}
          onDelete={handleQuickDeleteClick}
        />
      ) : null}
      {showOpenInEditorAction ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                actionButtonSizeClass,
              )}
              aria-label={t('sessions.sidebar.session.actions.openInEditor')}
              onPointerDown={handleRowActionPointerDown}
              onMouseDown={handleRowActionMouseDown}
              onClick={handleOpenInEditorClick}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Icon name="external-link" className={actionIconSizeClass} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {t('sessions.sidebar.session.actions.openInEditor')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu open={isMenuOpen} onOpenChange={onMenuOpenChange} onOpenChangeComplete={onMenuOpenChangeComplete}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              !alwaysShowActions
                ? cn('pointer-fine:hidden', isSessionMenuOpen
                    ? 'h-4 w-4 opacity-100'
                    : cn('h-4 w-4 opacity-0', revealOnHoverClass))
                : 'h-6 w-6 opacity-100',
            )}
            aria-label={t('sessions.sidebar.session.menu.label')}
            onPointerDown={handleMenuTriggerPointerDown}
            onMouseDown={handleMenuTriggerMouseDown}
            onClick={handleMenuTriggerClick}
            onKeyDown={(event) => event.stopPropagation()}
          >
             <Icon name="more-2" className={actionIconSizeClass} />
          </button>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
      </TooltipProvider>
    </div>
  );
}
