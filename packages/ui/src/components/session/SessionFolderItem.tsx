import React from 'react';
import {
  RiFolderLine,
  RiFolderOpenLine,
  RiArrowRightSLine,
  RiArrowDownSLine,
  RiPencilAiLine,
  RiDeleteBinLine,
  RiCheckLine,
  RiCloseLine,
  RiAddLine,
  RiFolderAddLine,
} from '@remixicon/react';
import { m } from '@/lib/i18n/messages';
import { cn } from '@/lib/utils';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';

interface SessionFolderItemProps<TSessionNode> {
  folder: SessionFolder;
  sessions: TSessionNode[];
  /** Sub-folders that belong directly to this folder */
  subFolderItems?: React.ReactNode;
  isCollapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  renderSessionNode: (
    node: TSessionNode,
    depth?: number,
    groupDir?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
  ) => React.ReactNode;
  groupDirectory?: string | null;
  projectId?: string | null;
  mobileVariant?: boolean;
  isRenaming?: boolean;
  renameDraft?: string;
  onRenameDraftChange?: (value: string) => void;
  onRenameSave?: () => void;
  onRenameCancel?: () => void;
  /** Ref callback from useDroppable – attach to folder header to make it a drop zone */
  droppableRef?: (node: HTMLElement | null) => void;
  /** Whether a draggable session is currently hovering over this folder */
  isDropTarget?: boolean;
  /** Create a new session scoped to this folder */
  onNewSession?: () => void;
  /** Create a new sub-folder inside this folder */
  onNewSubFolder?: () => void;
  /** Visual indent depth (0 = root folder, 1 = sub-folder) */
  depth?: number;
  /** Hide folder action buttons (rename/delete/new) */
  hideActions?: boolean;
  /** Whether folder belongs to archived section */
  archivedBucket?: boolean;
}

const SessionFolderItemBase = <TSessionNode,>({
  folder,
  sessions,
  subFolderItems,
  isCollapsed,
  onToggle,
  onRename,
  onDelete,
  renderSessionNode,
  groupDirectory,
  projectId,
  mobileVariant = false,
  isRenaming = false,
  renameDraft = '',
  onRenameDraftChange,
  onRenameSave,
  onRenameCancel,
  droppableRef,
  isDropTarget = false,
  onNewSession,
  onNewSubFolder,
  depth = 0,
  hideActions = false,
  archivedBucket = false,
}: SessionFolderItemProps<TSessionNode>) => {
  const [localRenaming, setLocalRenaming] = React.useState(false);
  const [localDraft, setLocalDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const renaming = isRenaming || localRenaming;
  const draft = isRenaming ? renameDraft : localDraft;

  const handleStartRename = React.useCallback(() => {
    setLocalDraft(folder.name);
    setLocalRenaming(true);
  }, [folder.name]);

  const handleSaveRename = React.useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== folder.name) {
      onRename(trimmed);
    }
    if (isRenaming && onRenameSave) {
      onRenameSave();
    }
    setLocalRenaming(false);
    setLocalDraft('');
  }, [draft, folder.name, isRenaming, onRename, onRenameSave]);

  const handleCancelRename = React.useCallback(() => {
    if (isRenaming && onRenameCancel) {
      onRenameCancel();
    }
    setLocalRenaming(false);
    setLocalDraft('');
  }, [isRenaming, onRenameCancel]);

  const handleDraftChange = React.useCallback(
    (value: string) => {
      if (isRenaming && onRenameDraftChange) {
        onRenameDraftChange(value);
      } else {
        setLocalDraft(value);
      }
    },
    [isRenaming, onRenameDraftChange],
  );

  // Auto-focus rename when externally triggered
  React.useEffect(() => {
    if (!isRenaming) return;
    const focusInput = () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };
    const frameId = requestAnimationFrame(focusInput);
    const timeoutId = window.setTimeout(focusInput, 0);
    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [isRenaming]);

  const FolderIcon = isCollapsed ? RiFolderLine : RiFolderOpenLine;
  const isSubFolder = depth > 0;

  return (
    <div className={cn('oc-folder', isSubFolder && 'ml-3')}>
      {/* Folder header – also acts as a drop zone when droppableRef is provided */}
      <div
        ref={droppableRef}
        className={cn(
          'group/folder relative flex items-center justify-between gap-1.5 py-1 min-w-0 rounded-md',
          'cursor-pointer',
          isDropTarget && 'bg-primary/10 ring-1 ring-inset ring-primary/30',
        )}
        onClick={renaming ? undefined : onToggle}
        role={renaming ? undefined : 'button'}
        tabIndex={renaming ? undefined : 0}
        onKeyDown={
          renaming
            ? undefined
            : (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggle();
                }
              }
        }
        aria-label={isCollapsed ? `Expand folder ${folder.name}` : `Collapse folder ${folder.name}`}
      >
        <div className={cn(
          'min-w-0 flex items-center gap-1.5 pl-1.5 flex-1 transition-[padding]',
          archivedBucket
            ? (mobileVariant ? 'pr-7' : 'group-hover/folder:pr-7 group-focus-within/folder:pr-7')
            : '',
        )}>
          <FolderIcon className={cn('h-3.5 w-3.5 flex-shrink-0', isDropTarget ? 'text-primary' : 'text-muted-foreground')} />

          {renaming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              data-keyboard-avoid="true"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                handleSaveRename();
              }}
            >
              <input
                ref={inputRef}
                value={draft}
                onChange={(event) => handleDraftChange(event.target.value)}
                className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
                autoFocus
                placeholder={m.sfiFolderName()}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    handleCancelRename();
                    return;
                  }
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.stopPropagation();
                  }
                }}
              />
              <button
                type="submit"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <RiCheckLine className="size-4" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleCancelRename();
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <RiCloseLine className="size-4" />
              </button>
            </form>
          ) : (
            <div className="min-w-0 flex items-center gap-1.5 flex-1">
              <span className={cn('typography-ui-label font-semibold truncate', isDropTarget ? 'text-primary' : 'text-muted-foreground')}>
                {folder.name}
              </span>
              <span className="typography-micro text-muted-foreground/70 flex-shrink-0">
                • {sessions.length}
              </span>
              {isCollapsed ? (
                <RiArrowRightSLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              ) : (
                <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              )}
            </div>
          )}

        </div>

        {/* Action buttons */}
        {!renaming && (!hideActions || archivedBucket) ? (
          <div className="flex items-center gap-0.5 px-0.5">
            <div
              className={cn(
                'flex items-center gap-0.5 transition-opacity',
                mobileVariant ? 'opacity-100' : 'opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100',
                archivedBucket && 'absolute right-0.5 top-1/2 z-10 -translate-y-1/2 px-0',
              )}
            >
              {!archivedBucket && onNewSession ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSession();
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={m.sfiNewSessionIn({ name: folder.name })}
                  title={m.sfiNewSession()}
                >
                  <RiAddLine className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {/* Only allow sub-folders at depth 0 (one level deep max) */}
              {!archivedBucket && onNewSubFolder && depth === 0 ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onNewSubFolder();
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={m.sfiNewSubFolderIn({ name: folder.name })}
                  title={m.sfiNewSubFolder()}
                >
                  <RiFolderAddLine className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {!archivedBucket ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleStartRename();
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={`Rename folder ${folder.name}`}
                >
                  <RiPencilAiLine className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={archivedBucket ? `Delete archived sessions in folder ${folder.name}` : `Delete folder ${folder.name}`}
              >
                <RiDeleteBinLine className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Folder body */}
      {!isCollapsed ? (
        <div className="pb-1 pl-2">
          {/* Sub-folders first */}
          {subFolderItems}
          {/* Then sessions */}
          {sessions.length > 0 ? (
            sessions.map((node) =>
              renderSessionNode(node, 0, groupDirectory ?? null, projectId ?? null, archivedBucket),
            )
          ) : !subFolderItems ? (
            <div className="py-1 pl-1.5 text-left typography-micro text-muted-foreground/70">
              {m.sfiEmptyFolder()}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const SessionFolderItem = React.memo(SessionFolderItemBase) as <TSessionNode>(
  props: SessionFolderItemProps<TSessionNode>,
) => React.ReactElement;
