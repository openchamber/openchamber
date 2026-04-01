import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import { RiAlertLine, RiLoader4Line, RiChat1Line, RiAddLine } from '@remixicon/react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { getConflictDetails, type MergeConflictDetails } from '@/lib/gitApi';

interface ConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflictFiles?: string[];
  directory: string;
  operation: 'merge' | 'rebase';
  onAbort: () => void;
  onClearState?: () => void;
}

export const ConflictDialog: React.FC<ConflictDialogProps> = ({
  open,
  onOpenChange,
  conflictFiles = [],
  directory,
  operation,
  onAbort,
  onClearState,
}) => {
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
  const setPendingSyntheticParts = useInputStore((state) => state.setPendingSyntheticParts);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);

  const [isLoading, setIsLoading] = React.useState(false);
  const [conflictDetails, setConflictDetails] = React.useState<MergeConflictDetails | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Fetch conflict details when dialog opens
  React.useEffect(() => {
    if (!open || !directory) return;

    setIsLoading(true);
    setLoadError(null);
    setConflictDetails(null);

    getConflictDetails(directory)
      .then((details) => {
        setConflictDetails(details);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load conflict details';
        setLoadError(message);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [open, directory]);

  const buildConflictContext = React.useCallback((): {
    visibleText: string;
    instructionsText: string;
    payloadText: string;
  } | null => {
    if (!conflictDetails) return null;

    const operationLabel = operation === 'merge' ? 'merge' : 'rebase';
    const headRef = conflictDetails.headInfo || (operation === 'merge' ? 'MERGE_HEAD' : 'REBASE_HEAD');
    const continueCmd = operation === 'merge' ? 'git commit --no-edit' : 'git rebase --continue';

    const visibleText = `Resolve ${operationLabel} conflicts, stage the resolved files, and complete the ${operationLabel}. Preserve the intent of changes from ${headRef}.`;

    const instructionsText = `Git ${operationLabel} operation is in progress with conflicts.
- Directory: ${directory}
- Operation: ${operation}
- Head Info: ${conflictDetails.headInfo || 'N/A'}

Required steps:
1. Read each conflicted file to understand the conflict markers (<<<<<<< HEAD, =======, >>>>>>> ...)
2. Edit each file to resolve conflicts by choosing the correct code or merging both changes appropriately
3. Stage all resolved files with: git add <file>
4. Complete the ${operationLabel} with: ${continueCmd}

Important:
- Remove ALL conflict markers from files (<<<<<<< HEAD, =======, >>>>>>>)
- Make sure the final code is syntactically correct and preserves intent from both sides
- Do not leave any files with unresolved conflict markers
- After completing all steps, confirm the ${operationLabel} was successful
`;

    const payloadText = `${operationLabel} conflict context (JSON)\n${JSON.stringify(
      {
        directory,
        operation: conflictDetails.operation,
        headInfo: conflictDetails.headInfo,
        statusPorcelain: conflictDetails.statusPorcelain,
        unmergedFiles: conflictDetails.unmergedFiles,
        diff: conflictDetails.diff,
      },
      null,
      2
    )}`;

    return { visibleText, instructionsText, payloadText };
  }, [conflictDetails, directory, operation]);

  const handleAbort = () => {
    onAbort();
    onOpenChange(false);
  };

  const handleContinueLater = () => {
    onClearState?.();
    onOpenChange(false);
  };

  const handleResolveInCurrentSession = () => {
    const context = buildConflictContext();
    if (!context) {
      toast.error('No conflict details available');
      return;
    }

    if (!currentSessionId) {
      toast.error('No active session', { description: 'Open a chat session first or use "New Session".' });
      return;
    }

    // Set the visible text in the input and the synthetic parts for when user sends
    setPendingInputText(context.visibleText, 'replace');
    setPendingSyntheticParts([
      { text: context.instructionsText, synthetic: true },
      { text: context.payloadText, synthetic: true },
    ]);

    setActiveMainTab('chat');
    onClearState?.();
    onOpenChange(false);
  };

  const handleResolveInNewSession = () => {
    const context = buildConflictContext();
    if (!context) {
      toast.error('No conflict details available');
      return;
    }

    // Open new session with the conflict context as initial prompt + synthetic parts
    openNewSessionDraft({
      directoryOverride: directory,
      initialPrompt: context.visibleText,
      syntheticParts: [
        { text: context.instructionsText, synthetic: true },
        { text: context.payloadText, synthetic: true },
      ],
    });
    // Navigate to chat tab so user sees the new session
    setActiveMainTab('chat');
    onClearState?.();
    onOpenChange(false);
  };

  const operationLabel = operation === 'merge' ? 'Merge' : 'Rebase';
  const displayFiles = conflictDetails?.unmergedFiles || conflictFiles;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-4 overflow-hidden">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <RiAlertLine className="size-5 shrink-0 text-[var(--status-warning)]" />
              <DialogTitle>{operationLabel} Conflicts Detected</DialogTitle>
            </div>
            <DialogDescription>
              The {operation} operation resulted in conflicts that need to be resolved.
            </DialogDescription>
          </DialogHeader>

          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
              <RiLoader4Line className="size-4 animate-spin" />
              <span className="typography-meta">Loading conflict details...</span>
            </div>
          )}

          {loadError && (
            <div className="rounded-lg bg-[var(--status-error-bg)] p-3 text-[var(--status-error)] typography-meta break-words">
              Error loading details: {loadError}
            </div>
          )}

          {displayFiles.length > 0 && (
            <div className="space-y-2 overflow-hidden">
              <div className="flex items-center justify-between">
                <p className="typography-meta text-muted-foreground">Conflicted files:</p>
                <span className="typography-micro px-1.5 py-0.5 rounded bg-[var(--surface-elevated)] text-muted-foreground">
                  {displayFiles.length}
                </span>
              </div>
              <div className="bg-[var(--surface-elevated)] rounded-lg p-3 max-h-40 overflow-y-auto overflow-x-hidden">
                <ul className="space-y-1">
                  {displayFiles.map((file, index) => (
                    <li
                      key={index}
                      className="typography-micro text-foreground font-mono truncate block"
                      title={file}
                    >
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {conflictDetails?.headInfo && (
            <div className="space-y-1 overflow-hidden">
              <p className="typography-meta text-muted-foreground">HEAD information:</p>
              <div className="typography-micro text-foreground font-mono bg-[var(--surface-elevated)] rounded-lg p-3 max-h-24 overflow-y-auto break-words whitespace-pre-wrap">
                {conflictDetails.headInfo}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              variant="default"
              onClick={handleResolveInNewSession}
              disabled={isLoading || !conflictDetails}
              className="w-full gap-2"
            >
              {isLoading ? (
                <RiLoader4Line className="size-4 animate-spin" />
              ) : (
                <RiAddLine className="size-4" />
              )}
              Resolve in New Session
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleResolveInCurrentSession()}
              disabled={isLoading || !conflictDetails || !currentSessionId}
              className="w-full gap-2"
            >
              {isLoading ? (
                <RiLoader4Line className="size-4 animate-spin" />
              ) : (
                <RiChat1Line className="size-4" />
              )}
              Resolve in Current Session
            </Button>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleContinueLater} className="flex-1">
                Continue Later
              </Button>
              <Button variant="destructive" size="sm" onClick={handleAbort} className="flex-1">
                Abort {operationLabel}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
