import {
  RiGitCommitLine,
  RiArrowUpLine,
  RiAiGenerate2,
  RiLoader4Line,
  RiEmotionHappyLine,
} from '@remixicon/react';
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { ButtonLarge } from '@/components/ui/button-large';
import { CommitInput } from './CommitInput';
import { AIHighlightsBox } from './AIHighlightsBox';
import { useDeviceInfo } from '@/lib/device';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/hooks/useLanguage';

type CommitAction = 'commit' | 'commitAndPush' | null;

interface CommitSectionProps {
  selectedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  generatedHighlights: string[];
  onInsertHighlights: () => void;
  onClearHighlights: () => void;
  onGenerateMessage: () => void;
  isGeneratingMessage: boolean;
  onCommit: () => void;
  onCommitAndPush: () => void;
  commitAction: CommitAction;
  isBusy: boolean;
  gitmojiEnabled: boolean;
  onOpenGitmojiPicker: () => void;
  variant?: 'framed' | 'plain';
}

export const CommitSection: React.FC<CommitSectionProps> = ({
  selectedCount,
  commitMessage,
  onCommitMessageChange,
  generatedHighlights,
  onInsertHighlights,
  onClearHighlights,
  onGenerateMessage,
  isGeneratingMessage,
  onCommit,
  onCommitAndPush,
  commitAction,
  isBusy,
  gitmojiEnabled,
  onOpenGitmojiPicker,
  variant = 'framed',
}) => {
  const { t } = useLanguage();
  const hasSelectedFiles = selectedCount > 0;
  const canCommit = commitMessage.trim() && hasSelectedFiles && commitAction === null;
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const containerClassName =
    variant === 'framed'
      ? 'rounded-xl border border-border/60 bg-background/70 overflow-hidden'
      : 'border-0 bg-transparent rounded-none';
  const headerClassName =
    variant === 'framed'
      ? 'flex w-full items-center justify-between px-3 py-2'
      : 'flex w-full items-center justify-between px-4 py-3 border-b border-border/40';
  const contentClassName =
    variant === 'framed'
      ? 'flex flex-col gap-3 p-3 pt-0'
      : 'flex flex-col gap-3 px-4 py-3';

  return (
    <Collapsible
      open={variant === 'plain' ? true : hasSelectedFiles}
      className={containerClassName}
      data-keyboard-avoid="true"
    >
      <div className={headerClassName}>
        <h3 className="typography-ui-header font-semibold text-foreground">{t('commitSection.title')}</h3>
        <span className="typography-meta text-muted-foreground">
          {hasSelectedFiles
            ? t('commitSection.filesSelected', { count: selectedCount })
            : t('commitSection.noFilesSelected')}
        </span>
      </div>

      <CollapsibleContent>
        <div className={contentClassName}>
          {!hasSelectedFiles ? (
            <p className="typography-meta text-muted-foreground">
              {t('commitSection.selectFilesToCommit')}
            </p>
          ) : null}

          <AIHighlightsBox
            highlights={generatedHighlights}
            onInsert={onInsertHighlights}
            onClear={onClearHighlights}
          />

          <CommitInput
            value={commitMessage}
            onChange={onCommitMessageChange}
            placeholder={t('commitSection.commitMessagePlaceholder')}
            disabled={commitAction !== null}
            hasTouchInput={hasTouchInput}
          />

          {gitmojiEnabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenGitmojiPicker}
              className="w-fit"
              type="button"
            >
              <RiEmotionHappyLine className="size-4" />
              {t('commitSection.addGitmoji')}
            </Button>
          )}

          <div className="@container/commit-actions flex items-center gap-2 min-w-0">
            <Button
              variant="outline"
              size="sm"
              onClick={onGenerateMessage}
              disabled={
                isGeneratingMessage ||
                commitAction !== null ||
                selectedCount === 0 ||
                isBusy
              }
              type="button"
              aria-label={t('commitSection.generate')}
              className="commit-actions__btn"
            >
              {isGeneratingMessage ? (
                <RiLoader4Line className="size-4 animate-spin" />
              ) : (
                <RiAiGenerate2 className="size-4 text-primary" />
              )}
              <span className="commit-actions__label">{t('commitSection.generate')}</span>
            </Button>

            <div className="flex-1" />

            <ButtonLarge
              variant="outline"
              onClick={onCommit}
              disabled={!canCommit || isGeneratingMessage}
              className="commit-actions__btn whitespace-nowrap"
              aria-label={t('commitSection.commit')}
            >
              {commitAction === 'commit' ? (
                <>
                  <RiLoader4Line className="size-4 animate-spin" />
                  <span className="commit-actions__label">{t('commitSection.committing')}</span>
                </>
              ) : (
                <>
                  <RiGitCommitLine className="size-4" />
                  <span className="commit-actions__label">{t('commitSection.commit')}</span>
                </>
              )}
            </ButtonLarge>

            {isMobile ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onCommitAndPush()}
                    disabled={!canCommit || isGeneratingMessage}
                    className="h-7 w-7 p-0"
                    aria-label={t('commitSection.commitAndPush')}
                  >
                    {commitAction === 'commitAndPush' ? (
                      <RiLoader4Line className="size-4 animate-spin" />
                    ) : (
                      <RiArrowUpLine className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{t('commitSection.commitAndPush')}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <ButtonLarge
                variant="default"
                onClick={() => onCommitAndPush()}
                disabled={!canCommit || isGeneratingMessage}
                className="commit-actions__btn"
                aria-label={t('commitSection.commitAndPush')}
              >
                {commitAction === 'commitAndPush' ? (
                  <>
                    <RiLoader4Line className="size-4 animate-spin" />
                    <span className="commit-actions__label commit-actions__label--long">{t('commitSection.pushing')}</span>
                  </>
                ) : (
                  <>
                    <RiArrowUpLine className="size-4" />
                    <span className="commit-actions__label commit-actions__label--long">{t('commitSection.commitAndPush')}</span>
                  </>
                )}
              </ButtonLarge>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
