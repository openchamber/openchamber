import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RiCheckLine,
  RiChatNewLine,
  RiEqualizer2Line,
  RiFolderAddLine,
  RiSearchLine,
  RiCloseLine,
  RiContractUpDownLine,
  RiExpandUpDownLine,
  RiStickyNoteLine,
} from '@remixicon/react';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { ProjectNotesTodoPanel } from '../ProjectNotesTodoPanel';

type Props = {
  hideDirectoryControls: boolean;
  handleOpenDirectoryDialog: () => void;
  handleNewSession: () => void;
  useMobileNotesPanel: boolean;
  projectNotesPanelOpen: boolean;
  setProjectNotesPanelOpen: (open: boolean) => void;
  activeProjectRefForHeader: ProjectRef | null;
  activeProjectLabelForHeader: string | null;
  stableActiveProjectIsRepo: boolean;
  headerActionIconClass: string;
  reserveHeaderActionsSpace: boolean;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAllProjects: () => void;
  expandAllProjects: () => void;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const {
    hideDirectoryControls,
    handleOpenDirectoryDialog,
    handleNewSession,
    useMobileNotesPanel,
    projectNotesPanelOpen,
    setProjectNotesPanelOpen,
    activeProjectRefForHeader,
    activeProjectLabelForHeader,
    stableActiveProjectIsRepo,
    headerActionIconClass,
    reserveHeaderActionsSpace,
    headerActionButtonClass,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAllProjects,
    expandAllProjects,
  } = props;

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const setDisplayMode = useSessionDisplayStore((state) => state.setDisplayMode);

  if (hideDirectoryControls) {
    return null;
  }

  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      {reserveHeaderActionsSpace ? (
        <div className="flex h-auto min-h-8 flex-col gap-1">
          <div className="flex h-8 items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleOpenDirectoryDialog}
                    className={headerActionButtonClass}
                    aria-label="Add project"
                  >
                    <RiFolderAddLine className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>Add project</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleNewSession}
                    className={headerActionButtonClass}
                    aria-label="New session"
                  >
                    <RiChatNewLine className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>New session</p></TooltipContent>
              </Tooltip>
            </div>

            <div className="flex items-center gap-1.5">
              {useMobileNotesPanel ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setProjectNotesPanelOpen(true)}
                      className={headerActionButtonClass}
                      aria-label="Project notes"
                      disabled={!activeProjectRefForHeader}
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
                          aria-label="Project notes"
                          disabled={!activeProjectRefForHeader}
                        >
                          <RiStickyNoteLine className={headerActionIconClass} />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}><p>Project notes</p></TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="start" className="w-[420px] max-w-[min(92vw,420px)] p-0">
                    <ProjectNotesTodoPanel
                      projectRef={activeProjectRefForHeader}
                      projectLabel={activeProjectLabelForHeader}
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={collapseAllProjects} className="flex items-center gap-2">
                    <RiContractUpDownLine className="h-4 w-4" />
                    <span>Collapse all</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={expandAllProjects} className="flex items-center gap-2">
                    <RiExpandUpDownLine className="h-4 w-4" />
                    <span>Expand all</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {isSessionSearchOpen ? (
            <div className="pb-1">
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
        </div>
      ) : null}
    </div>
  );
}
