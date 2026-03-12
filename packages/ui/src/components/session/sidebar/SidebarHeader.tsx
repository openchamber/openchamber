import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiEqualizer2Line,
  RiNodeTree,
  RiPencilAiLine,
  RiSearchLine,
  RiStickyNoteLine,
} from '@remixicon/react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { ProjectNotesTodoPanel } from '../ProjectNotesTodoPanel';
import { formatDirectoryName } from '@/lib/utils';
import { formatProjectLabel } from './utils';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

type ProjectItem = {
  id: string;
  label?: string;
  normalizedPath: string;
};

type ActiveProject = {
  id: string;
  label?: string;
  normalizedPath: string;
} | null;

type Props = {
  hideDirectoryControls: boolean;
  hideProjectSelector: boolean;
  activeProjectForHeader: ActiveProject;
  homeDirectory: string | null;
  normalizedProjects: ProjectItem[];
  activeProjectId: string | null;
  setActiveProjectIdOnly: (projectId: string) => void;
  isProjectRenameInline: boolean;
  setIsProjectRenameInline: (value: boolean) => void;
  handleStartInlineProjectRename: () => void;
  handleSaveInlineProjectRename: () => void;
  projectRenameDraft: string;
  setProjectRenameDraft: (value: string) => void;
  removeProject: (projectId: string) => void;
  handleOpenDirectoryDialog: () => void;
  addProjectButtonClass: string;
  headerActionIconClass: string;
  reserveHeaderActionsSpace: boolean;
  stableActiveProjectIsRepo: boolean;
  useMobileNotesPanel: boolean;
  projectNotesPanelOpen: boolean;
  setProjectNotesPanelOpen: (open: boolean) => void;
  activeProjectRefForHeader: ProjectRef | null;
  openMultiRunLauncher: () => void;
  headerActionButtonClass: string;
  setNewWorktreeDialogOpen: (open: boolean) => void;
  setActiveMainTab: (tab: 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files') => void;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const {
    hideDirectoryControls,
    hideProjectSelector,
    activeProjectForHeader,
    homeDirectory,
    normalizedProjects,
    activeProjectId,
    setActiveProjectIdOnly,
    isProjectRenameInline,
    setIsProjectRenameInline,
    handleStartInlineProjectRename,
    handleSaveInlineProjectRename,
    projectRenameDraft,
    setProjectRenameDraft,
    removeProject,
    addProjectButtonClass,
    headerActionIconClass,
    reserveHeaderActionsSpace,
    stableActiveProjectIsRepo,
    useMobileNotesPanel,
    projectNotesPanelOpen,
    setProjectNotesPanelOpen,
    activeProjectRefForHeader,
    openMultiRunLauncher,
    headerActionButtonClass,
    setNewWorktreeDialogOpen,
    setActiveMainTab,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
  } = props;

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const setDisplayMode = useSessionDisplayStore((state) => state.setDisplayMode);

  if (hideDirectoryControls) {
    return null;
  }

  return (
    <div className={`select-none pl-3.5 pr-2 flex-shrink-0 border-b border-border/60 ${hideProjectSelector ? 'py-1' : 'py-1.5'}`}>
      {!hideProjectSelector && (
        <div className="flex h-8 items-center justify-between gap-2">
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) setIsProjectRenameInline(false);
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 min-w-0 max-w-[calc(100%-2.5rem)] cursor-pointer items-center gap-1 rounded-md px-2 text-left text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <span className="text-base font-semibold truncate">
                  {activeProjectForHeader
                    ? formatProjectLabel(
                      activeProjectForHeader.label?.trim()
                      || formatDirectoryName(activeProjectForHeader.normalizedPath, homeDirectory)
                      || activeProjectForHeader.normalizedPath,
                    )
                    : 'Projects'}
                </span>
                <RiArrowDownSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px] max-w-[320px]">
              {normalizedProjects.map((project) => {
                const label = formatProjectLabel(
                  project.label?.trim()
                  || formatDirectoryName(project.normalizedPath, homeDirectory)
                  || project.normalizedPath,
                );
                return (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={() => setActiveProjectIdOnly(project.id)}
                    className={`truncate ${project.id === activeProjectId ? 'text-primary' : ''}`}
                  >
                    <span className="truncate">{label}</span>
                  </DropdownMenuItem>
                );
              })}
              <div className="my-1 h-px bg-border/70" />
              {!isProjectRenameInline ? (
                <DropdownMenuItem
                  onClick={(event) => {
                    event.preventDefault();
                    handleStartInlineProjectRename();
                  }}
                  className="gap-2"
                >
                  <RiPencilAiLine className="h-4 w-4" />
                  Rename project
                </DropdownMenuItem>
              ) : (
                <div className="px-2 py-1.5">
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleSaveInlineProjectRename();
                    }}
                  >
                    <input
                      value={projectRenameDraft}
                      onChange={(event) => setProjectRenameDraft(event.target.value)}
                      className="h-7 flex-1 rounded border border-border bg-transparent px-2 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      placeholder="Rename project"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setIsProjectRenameInline(false);
                          return;
                        }
                        if (event.key === ' ' || event.key === 'Enter') {
                          event.stopPropagation();
                        }
                      }}
                    />
                    <button type="submit" className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground">
                      <RiCheckLine className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsProjectRenameInline(false)}
                      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    >
                      <RiCloseLine className="h-4 w-4" />
                    </button>
                  </form>
                </div>
              )}
              <DropdownMenuItem
                onClick={() => {
                  if (!activeProjectForHeader) return;
                  removeProject(activeProjectForHeader.id);
                }}
                className="text-destructive focus:text-destructive gap-2"
              >
                <RiCloseLine className="h-4 w-4" />
                Close project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={addProjectButtonClass}
                    aria-label="Session display mode"
                  >
                    <RiEqualizer2Line className={headerActionIconClass} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>Display mode</p></TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem
                onClick={() => setDisplayMode('default')}
                className="flex items-center justify-between"
              >
                <span>Default</span>
                {displayMode === 'default' ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setDisplayMode('minimal')}
                className="flex items-center justify-between"
              >
                <span>Minimal</span>
                {displayMode === 'minimal' ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {reserveHeaderActionsSpace ? (
        <div className="-ml-1 flex h-auto min-h-8 flex-col gap-1">
          {activeProjectForHeader ? (
            <>
              <div className="flex h-8 -translate-y-px items-center justify-between gap-1.5 rounded-md pl-0 pr-1">
                <div className="flex items-center gap-1.5">
                {stableActiveProjectIsRepo ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!activeProjectForHeader) return;
                            if (activeProjectForHeader.id !== activeProjectId) {
                              setActiveProjectIdOnly(activeProjectForHeader.id);
                            }
                            setActiveMainTab('chat');
                            setNewWorktreeDialogOpen(true);
                          }}
                          className={headerActionButtonClass}
                          aria-label="New worktree"
                        >
                          <RiNodeTree className={headerActionIconClass} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}><p>New worktree</p></TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={openMultiRunLauncher}
                          className={headerActionButtonClass}
                          aria-label="New multi-run"
                        >
                          <ArrowsMerge className={headerActionIconClass} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}><p>New multi-run</p></TooltipContent>
                    </Tooltip>
                  </>
                ) : null}

                {useMobileNotesPanel ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setProjectNotesPanelOpen(true)}
                        className={headerActionButtonClass}
                        aria-label="Project notes and todos"
                      >
                        <RiStickyNoteLine className={headerActionIconClass} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}><p>Project notes</p></TooltipContent>
                  </Tooltip>
                ) : (
                  <DropdownMenu open={projectNotesPanelOpen} onOpenChange={setProjectNotesPanelOpen} modal={false}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={headerActionButtonClass}
                            aria-label="Project notes and todos"
                          >
                            <RiStickyNoteLine className={headerActionIconClass} />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}><p>Project notes</p></TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="start" className="w-[340px] p-0">
                      <ProjectNotesTodoPanel
                        projectRef={activeProjectRefForHeader}
                        canCreateWorktree={stableActiveProjectIsRepo}
                        onActionComplete={() => setProjectNotesPanelOpen(false)}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setIsSessionSearchOpen((prev) => !prev)}
                      className={headerActionButtonClass}
                      aria-label="Search sessions"
                      aria-expanded={isSessionSearchOpen}
                    >
                      <RiSearchLine className={headerActionIconClass} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>Search sessions</p></TooltipContent>
                </Tooltip>
                </div>

                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={headerActionButtonClass}
                          aria-label="Session display mode"
                        >
                          <RiEqualizer2Line className={headerActionIconClass} />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}><p>Display mode</p></TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuItem
                      onClick={() => setDisplayMode('default')}
                      className="flex items-center justify-between"
                    >
                      <span>Default</span>
                      {displayMode === 'default' ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setDisplayMode('minimal')}
                      className="flex items-center justify-between"
                    >
                      <span>Minimal</span>
                      {displayMode === 'minimal' ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {isSessionSearchOpen ? (
                <div className="px-1 pb-1">
                  <div className="mb-1 flex items-center justify-between px-0.5 typography-micro text-muted-foreground/80">
                    {hasSessionSearchQuery ? (
                      <span>{searchMatchCount} {searchMatchCount === 1 ? 'match' : 'matches'}</span>
                    ) : <span />}
                    <span>Esc to clear</span>
                  </div>
                  <div className="relative">
                    <RiSearchLine className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={sessionSearchInputRef}
                      value={sessionSearchQuery}
                      onChange={(event) => setSessionSearchQuery(event.target.value)}
                      placeholder="Search sessions..."
                      className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-8 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          if (hasSessionSearchQuery) {
                            setSessionSearchQuery('');
                          } else {
                            setIsSessionSearchOpen(false);
                          }
                        }
                      }}
                    />
                    {sessionSearchQuery.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setSessionSearchQuery('')}
                        className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        aria-label="Clear search"
                      >
                        <RiCloseLine className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
