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
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
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
        const message = err instanceof Error ? err.message : t('gitView.conflict.loadFailed');
        setLoadError(message);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [open, directory]);

  const buildConflictContext = React.useCallback(async (): Promise<{
    visibleText: string;
    instructionsText: string;
    payloadText: string;
  } | null> => {
    if (!conflictDetails) return null;

    const operationLabel = operation === 'merge' ? 'merge' : 'rebase';
    const headRef = conflictDetails.headInfo || (operation === 'merge' ? 'MERGE_HEAD' : 'REBASE_HEAD');
    const continueCmd = operation === 'merge' ? 'git commit --no-edit' : 'git rebase --continue';

    const visibleText = await renderMagicPrompt('git.conflict.resolve.visible', {
      operation_label: operationLabel,
      head_ref: headRef,
    });

    const instructionsText = await renderMagicPrompt('git.conflict.resolve.instructions', {
      operation_label: operationLabel,
      directory,
      operation,
      head_info: conflictDetails.headInfo || 'N/A',
      continue_cmd: continueCmd,
    });

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

  const handleResolveInCurrentSession = async () => {
    const context = await buildConflictContext();
    if (!context) {
      toast.error(t('gitView.conflict.noDetailsAvailable'));
      return;
    }

    if (!currentSessionId) {
      toast.error(t('gitView.conflict.noActiveSession'), { description: t('gitView.conflict.noActiveSessionDescription') });
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

  const handleResolveInNewSession = async () => {
    const context = await buildConflictContext();
    if (!context) {
      toast.error(t('gitView.conflict.noDetailsAvailable'));
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

  const operationLabel = operation === 'merge' ? t('gitView.operation.merge') : t('gitView.operation.rebase');
  const displayFiles = conflictDetails?.unmergedFiles || conflictFiles;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-4 overflow-hidden">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <RiAlertLine className="size-5 shrink-0 text-[var(--status-warning)]" />
              <DialogTitle>{t('gitView.conflict.detectedTitle', { operation: operationLabel })}</DialogTitle>
            </div>
            <DialogDescription>
              {t('gitView.conflict.detectedDescription', { operation })}
            </DialogDescription>
          </DialogHeader>

          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
              <RiLoader4Line className="size-4 animate-spin" />
              <span className="typography-meta">{t('gitView.conflict.loading')}</span>
            </div>
          )}

          {loadError && (
            <div className="rounded-lg bg-[var(--status-error-bg)] p-3 text-[var(--status-error)] typography-meta break-words">
              {t('gitView.conflict.errorLoadingDetails', { message: loadError })}
            </div>
          )}

          {displayFiles.length > 0 && (
            <div className="space-y-2 overflow-hidden">
              <div className="flex items-center justify-between">
                <p className="typography-meta text-muted-foreground">{t('gitView.conflict.conflictedFiles')}</p>
                <span className="typography-micro px-1.5 py-0.5 rounded bg-[var(--surface-elevated)] text-muted-foreground">
                  {displayFiles.length}
                </span>
              </div>
              <div className="bg-[var(--surface-elevated)] rounded-lg p-3 max-h-40 overflow-y-auto overflow-x-hidden">
                <ul className="space-y-1">
                  {displayFiles.map((file) => (
                    <li
                      key={file}
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
              <p className="typography-meta text-muted-foreground">{t('gitView.conflict.headInfo')}</p>
              <div className="typography-micro text-foreground font-mono bg-[var(--surface-elevated)] rounded-lg p-3 max-h-24 overflow-y-auto break-words whitespace-pre-wrap">
                {conflictDetails.headInfo}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              variant="default"
              onClick={() => {
                void handleResolveInNewSession();
              }}
              disabled={isLoading || !conflictDetails}
              className="w-full gap-2"
            >
              {isLoading ? (
                <RiLoader4Line className="size-4 animate-spin" />
              ) : (
                <RiAddLine className="size-4" />
              )}
              {t('gitView.conflict.resolveNewSession')}
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
              {t('gitView.conflict.resolveCurrentSession')}
            </Button>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleContinueLater} className="flex-1">
                {t('gitView.conflict.continueLater')}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleAbort} className="flex-1">
                {t('gitView.conflict.abortOperation', { operation: operationLabel })}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
