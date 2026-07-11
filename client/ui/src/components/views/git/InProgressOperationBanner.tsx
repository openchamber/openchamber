import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import type { GitMergeInProgress, GitRebaseInProgress } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

interface InProgressOperationBannerProps {
  mergeInProgress: GitMergeInProgress | null | undefined;
  rebaseInProgress: GitRebaseInProgress | null | undefined;
  onContinue: () => Promise<void>;
  onAbort: () => Promise<void>;
  onResolveWithAI?: () => void;
  hasUnresolvedConflicts?: boolean;
  isLoading?: boolean;
}

export const InProgressOperationBanner: React.FC<InProgressOperationBannerProps> = ({
  mergeInProgress,
  rebaseInProgress,
  onContinue,
  onAbort,
  onResolveWithAI,
  hasUnresolvedConflicts = false,
  isLoading = false,
}) => {
  const { t } = useI18n();
  const [processingAction, setProcessingAction] = React.useState<'continue' | 'abort' | null>(null);

  // Only show banner if we have actual in-progress operation data
  const hasMergeInProgress = mergeInProgress && mergeInProgress.head;
  const hasRebaseInProgress = rebaseInProgress && (rebaseInProgress.headName || rebaseInProgress.onto);
  const operation = hasMergeInProgress ? 'merge' : hasRebaseInProgress ? 'rebase' : null;
  
  if (!operation) {
    return null;
  }

  const handleContinue = async () => {
    setProcessingAction('continue');
    try {
      await onContinue();
    } finally {
      setProcessingAction(null);
    }
  };

  const handleAbort = async () => {
    setProcessingAction('abort');
    try {
      await onAbort();
    } finally {
      setProcessingAction(null);
    }
  };

  const isProcessing = processingAction !== null;

  const operationLabel = operation === 'merge' ? t('gitView.operation.merge') : t('gitView.operation.rebase');
  const operationIconName = operation === 'merge' ? 'git-merge' : 'git-branch';

  // Build description
  let description = '';
  if (mergeInProgress) {
    description = mergeInProgress.message 
      ? t('gitView.operation.mergingMessage', { message: mergeInProgress.message })
      : t('gitView.operation.mergeInProgressWithHead', { head: mergeInProgress.head });
  } else if (rebaseInProgress) {
    description = rebaseInProgress.headName 
      ? t('gitView.operation.rebasingOnto', { headName: rebaseInProgress.headName, onto: rebaseInProgress.onto || '' })
      : t('gitView.operation.rebaseInProgress');
  }

  return (
    <div className="bg-[var(--status-warning-bg)] border border-[var(--status-warning)] rounded-lg p-3 mx-3 mt-3">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Icon name={operationIconName} className="size-4 text-[var(--status-warning)] shrink-0" />
          <div className="min-w-0">
            <p className="typography-label text-[var(--status-warning)]">
              {t('gitView.operation.inProgressTitle', { operation: operationLabel })}
            </p>
            {description && (
              <p className="typography-micro text-muted-foreground truncate">
                {description}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasUnresolvedConflicts && onResolveWithAI && (
            <Button
              variant="outline"
              size="sm"
              onClick={onResolveWithAI}
              disabled={isProcessing || isLoading}
              className="gap-1.5"
            >
              <Icon name="sparkling" className="size-4" />
              {t('gitView.operation.resolveWithAi')}
            </Button>
          )}

          {processingAction !== 'continue' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAbort}
              disabled={isProcessing || isLoading}
              className="gap-1.5"
            >
              {processingAction === 'abort' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="close" className="size-4" />
              )}
              {t('gitView.operation.abort')}
            </Button>
          )}

          {!hasUnresolvedConflicts && (
            <Button
              variant="default"
              size="sm"
              onClick={handleContinue}
              disabled={isProcessing || isLoading}
              className="gap-1.5"
            >
              {processingAction === 'continue' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="check" className="size-4" />
              )}
              {t('gitView.operation.continue')}
            </Button>
          )}
        </div>

        {hasUnresolvedConflicts && (
          <p className="typography-micro text-[var(--status-warning)]">
            {t('gitView.operation.resolveConflictsHint')}
          </p>
        )}
      </div>
    </div>
  );
};
