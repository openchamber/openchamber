import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useI18n } from '@/lib/i18n';

export type SortableDragHandleProps = {
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
};

type ProjectIdentityProps = {
  id: string;
  projectLabel: string;
  projectIcon?: string;
  projectColor?: string;
  projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  projectIconBackground?: string;
};

type ProjectPickerOption = ProjectIdentityProps & {
  projectDescription: string;
};

type ProjectHeaderIdentityProps = ProjectIdentityProps & {
  isCollapsed?: boolean;
  alwaysShowActions?: boolean;
};

export const ProjectHeaderIdentity: React.FC<ProjectHeaderIdentityProps> = ({
  id,
  projectLabel,
  projectIcon,
  projectColor,
  projectIconImage,
  projectIconBackground,
  isCollapsed,
  alwaysShowActions = false,
}) => {
  const { currentTheme } = useThemeSystem();
  const projectIconName = projectIcon ? PROJECT_ICON_MAP[projectIcon] : null;
  const iconColor = projectColor ? (PROJECT_COLOR_MAP[projectColor] ?? null) : null;
  const hasCollapseControl = isCollapsed !== undefined;
  const iconVisibilityClassName = hasCollapseControl
    ? (alwaysShowActions ? 'hidden' : 'group-hover/project:hidden group-focus-within/project:hidden')
    : undefined;

  return (
    <>
      <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        {hasCollapseControl ? (
          <span className={cn(
            'h-3.5 w-3.5 items-center justify-center text-muted-foreground',
            alwaysShowActions ? 'inline-flex' : 'hidden group-hover/project:inline-flex group-focus-within/project:inline-flex',
          )}>
            <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {projectIconImage ? (
          <span
            className={cn(
              'h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-[3px]',
              hasCollapseControl && alwaysShowActions ? 'hidden' : 'inline-flex',
              iconVisibilityClassName,
            )}
            style={projectIconBackground ? { backgroundColor: projectIconBackground } : undefined}
          >
            <ProjectIconImage
              project={{ id, iconImage: projectIconImage }}
              options={{
                themeVariant: currentTheme.metadata.variant,
                iconColor: currentTheme.colors.surface.foreground,
              }}
              className="h-full w-full object-contain"
              fallback={projectIconName ? (
                <Icon name={projectIconName} className="h-3.5 w-3.5" style={iconColor ? { color: iconColor } : undefined} />
              ) : (
                <Icon name="folder" className="h-3.5 w-3.5 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
              )}
            />
          </span>
        ) : projectIconName ? (
          <Icon name={projectIconName} className={cn('h-3.5 w-3.5', iconVisibilityClassName)} style={iconColor ? { color: iconColor } : undefined} />
        ) : (
          <Icon name="folder" className={cn('h-3.5 w-3.5 text-muted-foreground/80', iconVisibilityClassName)} style={iconColor ? { color: iconColor } : undefined} />
        )}
      </span>
      <span className="truncate text-[14px] font-semibold lowercase text-foreground">{projectLabel}</span>
    </>
  );
};

export interface SortableProjectItemProps extends ProjectIdentityProps {
  disabled?: boolean;
  projectDescription: string;
  isCollapsed: boolean;
  isRepo: boolean;
  isDesktopShell: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onManageWorktrees?: () => void;
  onRenameStart: () => void;
  onClose: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
  children?: React.ReactNode;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  /** Aggregated activity/attention indicator shown while the project is collapsed. */
  statusIndicator?: React.ReactNode;
  projectPickerOptions?: ProjectPickerOption[];
  onProjectSelect?: (projectId: string) => void;
}

export const SortableProjectItem: React.FC<SortableProjectItemProps> = ({
  id,
  disabled = false,
  projectLabel,
  projectDescription,
  projectIcon,
  projectColor,
  projectIconImage,
  projectIconBackground,
  isCollapsed,
  isRepo,
  isDesktopShell,
  hideDirectoryControls,
  alwaysShowActions,
  onToggle,
  onNewSession,
  onNewWorktreeSession,
  onManageWorktrees,
  onRenameStart,
  onClose,
  sentinelRef,
  children,
  showCreateButtons = true,
  hideHeader = false,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  statusIndicator = null,
  projectPickerOptions,
  onProjectSelect,
}) => {
  const { t } = useI18n();
  const stickyZoneHeaders = useSessionDisplayStore((state) => state.stickyZoneHeaders);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const suppressNextToggleRef = React.useRef(false);
  const menuInstanceKey = `project:${id}`;
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);

  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    if (open) setIsContextMenuOpen(false);
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  }, [menuInstanceKey, setOpenSidebarMenuKey]);

  const renderProjectMenuItems = (Item: React.ElementType) => (
    <>
      {showCreateButtons && !isRepo && !hideDirectoryControls && onNewSession && (
        <Item onClick={onNewSession}>
          <Icon name="add" className="mr-1.5 h-4 w-4" />
          {t('sessions.sidebar.project.actions.newSession')}
        </Item>
      )}
      {isRepo && !hideDirectoryControls && onManageWorktrees && (
        <Item onClick={onManageWorktrees}>
          <Icon name="node-tree" className="mr-1.5 h-4 w-4" />
          {t('sessions.sidebar.project.actions.manageWorktrees')}
        </Item>
      )}
      <Item onClick={onRenameStart}>
        <Icon name="pencil-ai" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.edit')}
      </Item>
      <Item onClick={onClose} className="text-destructive focus:text-destructive">
        <Icon name="close" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.closeProject')}
      </Item>
    </>
  );

  const handleMenuTriggerClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleToggleMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextToggleRef.current = true;
    }
  }, []);

  const handleToggleClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    // Drop mouse-click focus so hover-revealed chrome (chevron, actions)
    // hides again on mouse-leave instead of sticking via :focus-within.
    // Keyboard users keep their focus-visible ring (blur only fires here
    // for pointer interactions that produced a click).
    event.currentTarget.blur();
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);
  const isProjectPicker = Boolean(projectPickerOptions && onProjectSelect);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-30')}
    >
      {!hideHeader ? (
        <>
          {isDesktopShell && (
            <div
              ref={sentinelRef}
              data-project-id={id}
              className="absolute top-0 h-px w-full pointer-events-none"
              aria-hidden="true"
            />
          )}

          <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
            <ContextMenuTrigger
              render={
                // Sticky zone header: this trigger div is a direct child of
                // the project wrapper (which spans header + sessions), so it
                // can stick for the whole zone.
                // Full-bleed band: pull past the list container's padding so
                // the section band spans the entire sidebar width (ref: edge-
                // to-edge section headers, not rounded pills).
                <div
                  className={cn(
                    '-ml-2.5 -mr-2 text-left group/project select-none',
                    stickyZoneHeaders && 'sticky top-0 z-20 bg-sidebar',
                  )}
                  data-sidebar-sticky-header={stickyZoneHeaders ? 'true' : undefined}
                  onContextMenu={(event) => {
                    // VS Code hides project actions entirely (hideDirectoryControls).
                    if (hideDirectoryControls) return;
                    event.preventDefault();
                    setIsContextMenuOpen(true);
                  }}
                />
              }
            >
            <div
              className="relative flex items-center gap-1 py-1 pl-4 pr-3.5"
              {...attributes}
            >
              {isProjectPicker ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      title={projectDescription}
                      className={cn(
                        'flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md transition-[padding]',
                        isRepo && !hideDirectoryControls
                          ? (alwaysShowActions ? 'pr-20' : 'pr-7 group-hover/project:pr-20 group-focus-within/project:pr-20')
                          : (alwaysShowActions ? 'pr-14' : 'pr-7 group-hover/project:pr-14 group-focus-within/project:pr-14'),
                      )}
                      aria-label={t('sessions.sidebar.project.selectAria', { project: projectLabel })}
                    >
                      <ProjectHeaderIdentity
                        id={id}
                        projectLabel={projectLabel}
                        projectIcon={projectIcon}
                        projectColor={projectColor}
                        projectIconImage={projectIconImage}
                        projectIconBackground={projectIconBackground}
                      />
                      <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="min-w-[220px] max-w-[calc(100vw-2rem)] max-h-[min(var(--available-height),70vh)] overflow-y-auto overscroll-contain"
                  >
                    {projectPickerOptions?.map((option) => (
                      <DropdownMenuItem
                        key={option.id}
                        onClick={() => onProjectSelect?.(option.id)}
                        className="flex items-center justify-between gap-3"
                        title={option.projectDescription}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <ProjectHeaderIdentity
                            id={option.id}
                            projectLabel={option.projectLabel}
                            projectIcon={option.projectIcon}
                            projectColor={option.projectColor}
                            projectIconImage={option.projectIconImage}
                            projectIconBackground={option.projectIconBackground}
                          />
                        </span>
                        {option.id === id ? <Icon name="check" className="h-4 w-4 flex-shrink-0 text-primary" /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Tooltip delayDuration={800}>
                  <TooltipTrigger asChild>
                      <button
                        type="button"
                        onMouseDown={handleToggleMouseDown}
                        onClick={handleToggleClick}
                        {...listeners}
                        className={cn(
                          'flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md cursor-grab active:cursor-grabbing transition-[padding]',
                          isRepo && !hideDirectoryControls
                            ? (alwaysShowActions ? 'pr-20' : 'pr-7 group-hover/project:pr-20 group-focus-within/project:pr-20')
                            : (alwaysShowActions ? 'pr-14' : 'pr-7 group-hover/project:pr-14 group-focus-within/project:pr-14'),
                        )}
                      >
                      <ProjectHeaderIdentity
                        id={id}
                        projectLabel={projectLabel}
                        projectIcon={projectIcon}
                        projectColor={projectColor}
                        projectIconImage={projectIconImage}
                        projectIconBackground={projectIconBackground}
                        isCollapsed={isCollapsed}
                        alwaysShowActions={alwaysShowActions}
                      />
                      {statusIndicator ? (
                        <span className="ml-1 inline-flex flex-shrink-0 items-center">{statusIndicator}</span>
                      ) : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {projectDescription}
                  </TooltipContent>
                </Tooltip>
              )}

              <div className={cn(
                'absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1',
                showCreateButtons ? 'right-7' : 'right-0.5',
              )}>
                {showCreateButtons && isRepo && !hideDirectoryControls && onNewWorktreeSession ? (
                  <Tooltip delayDuration={500}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewWorktreeSession();
                        }}
                        className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.newWorktree')}
                      >
                        <Icon name="node-tree" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{t('sessions.sidebar.project.actions.newWorktreeEllipsis')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {!hideDirectoryControls ? (
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={handleMenuOpenChange}
                >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                          isMenuOpen
                            ? 'opacity-100 pointer-events-auto'
                            : alwaysShowActions
                              ? 'opacity-100'
                              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                        onPointerDown={handleMenuTriggerPointerDown}
                        onMouseDown={handleMenuTriggerMouseDown}
                        onClick={handleMenuTriggerClick}
                      >
                        <Icon name="more-2" className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      {renderProjectMenuItems(DropdownMenuItem)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {showCreateButtons && onNewSession ? (
                <div className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2">
                  <Tooltip delayDuration={500}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSession();
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={isRepo
                          ? t('sessions.sidebar.project.actions.newDraftSession')
                          : t('sessions.sidebar.project.actions.newSession')}
                      >
                        <Icon name="add" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{isRepo
                        ? t('sessions.sidebar.project.actions.newDraftSession')
                        : t('sessions.sidebar.project.actions.newSession')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[180px]">
              {renderProjectMenuItems(ContextMenuItem)}
            </ContextMenuContent>
          </ContextMenu>
        </>
      ) : null}

      {children}
    </div>
  );
};

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode | ((dragHandleProps: SortableDragHandleProps) => React.ReactNode);
}> = ({ id, disabled = false, children }) => {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const dragHandleProps = React.useMemo<SortableDragHandleProps>(() => ({
    listeners,
    setActivatorNodeRef,
  }), [listeners, setActivatorNodeRef]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
    >
      {typeof children === 'function' ? children(dragHandleProps) : children}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
