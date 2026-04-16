import React from 'react';
import { RiGitBranchLine, RiEditLine, RiCheckLine, RiCloseLine, RiLoader4Line } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { m } from '@/lib/i18n/messages';

interface WorktreeBranchDisplayProps {
  currentBranch: string | null | undefined;
  onRename?: (oldName: string, newName: string) => Promise<void>;
  showEditButton?: boolean;
}

const sanitizeBranchNameInput = (value: string): string => {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\/-+/g, '/')
    .replace(/-+\//g, '/')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');
};

export const WorktreeBranchDisplay: React.FC<WorktreeBranchDisplayProps> = ({
  currentBranch,
  onRename,
  showEditButton = true,
}) => {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editBranchName, setEditBranchName] = React.useState(currentBranch || '');
  const [isRenaming, setIsRenaming] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleStartEdit = () => {
    if (!currentBranch || !onRename) return;
    setEditBranchName(currentBranch);
    setIsEditing(true);
    // Focus input after state update
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSaveEdit = async () => {
    if (!currentBranch || !onRename || !editBranchName.trim()) return;
    
    const sanitizedName = sanitizeBranchNameInput(editBranchName);
    if (sanitizedName === currentBranch) {
      setIsEditing(false);
      return;
    }

    setIsRenaming(true);
    try {
      await onRename(currentBranch, sanitizedName);
      setIsEditing(false);
      setEditBranchName('');
    } finally {
      setIsRenaming(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditBranchName('');
  };

  // Handle Enter key to save, Escape to cancel
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-primary/12 px-2 py-1 h-8">
        <form
          className="flex w-full items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveEdit();
          }}
        >
          <RiGitBranchLine className="size-4 text-primary" />
          <input
            ref={inputRef}
            value={editBranchName}
            onChange={(e) => setEditBranchName(e.target.value)}
            className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
            placeholder={m.wbdBranchName()}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            type="submit"
            disabled={isRenaming}
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {isRenaming ? (
              <RiLoader4Line className="size-4 animate-spin" />
            ) : (
              <RiCheckLine className="size-4" />
            )}
          </button>
          <button
            type="button"
            onClick={handleCancelEdit}
            disabled={isRenaming}
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RiCloseLine className="size-4" />
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 h-8">
      <RiGitBranchLine className="size-4 text-primary shrink-0" />
      <div className="inline-flex min-w-0 max-w-full items-center gap-1">
        <span className="truncate typography-ui-label font-normal text-foreground">
          {currentBranch || 'Detached HEAD'}
        </span>
        {showEditButton && onRename && currentBranch && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 shrink-0"
            onClick={handleStartEdit}
            title={m.wbdRenameBranch()}
          >
            <RiEditLine className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
};
