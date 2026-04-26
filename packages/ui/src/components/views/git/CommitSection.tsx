import {
  RiGitCommitLine,
  RiArrowUpLine,
  RiAiGenerate2,
  RiLoader4Line,
  RiEmotionHappyLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { CommitInput } from './CommitInput';
import { AIHighlightsBox } from './AIHighlightsBox';
import { useDeviceInfo } from '@/lib/device';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

type CommitAction = 'commit' | 'commitAndPush' | null;

interface CommitSectionProps {
  selectedCount: number;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  generatedHighlights: string[];
  onInsertHighlights: (highlights: string[]) => void;
  onGenerateMessage: () => void;
  isGeneratingMessage: boolean;
  onCommit: () => void;
  onCommitAndPush: () => void;
  commitAction: CommitAction;
  isBusy: boolean;
  gitmojiEnabled: boolean;
  onOpenGitmojiPicker: () => void;
}

export const CommitSection: React.FC<CommitSectionProps> = ({
  selectedCount,
  commitMessage,
  onCommitMessageChange,
  generatedHighlights,
  onInsertHighlights,
  onGenerateMessage,
  isGeneratingMessage,
  onCommit,
  onCommitAndPush,
  commitAction,
  isBusy,
  gitmojiEnabled,
  onOpenGitmojiPicker,
}) => {
  const { t } = useI18n();
  const hasSelectedFiles = selectedCount > 0;
  const canCommit = commitMessage.trim() && hasSelectedFiles && commitAction === null;
  const { isMobile, hasTouchInput } = useDeviceInfo();

  const containerClassName = 'border-0 bg-transparent rounded-none';
  const headerClassName = 'flex w-full items-center justify-between px-0 pt-2 pb-1';
  const contentClassName = 'flex flex-col gap-3 px-0 pt-1 pb-3';

  return (
    <section className={containerClassName}>
      <div className={headerClassName}>
        <h3 className="typography-ui-header font-semibold text-foreground">{t('gitView.commit.title')}</h3>
      </div>

      <div className={contentClassName}>
        {!hasSelectedFiles ? (
          <p className="typography-meta text-muted-foreground">
            {t('gitView.commit.selectFilesHint')}
          </p>
        ) : null}

        <AIHighlightsBox
          highlights={generatedHighlights}
          onInsert={onInsertHighlights}
        />

        <CommitInput
          value={commitMessage}
          onChange={onCommitMessageChange}
          placeholder={t('gitView.commit.messagePlaceholder')}
          disabled={commitAction !== null}
          hasTouchInput={hasTouchInput}
          isMobile={isMobile}
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
            {t('gitView.commit.addGitmoji')}
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
            aria-label={t('gitView.commit.generateAria')}
            className="commit-actions__btn"
          >
            {isGeneratingMessage ? (
              <RiLoader4Line className="size-4 animate-spin" />
            ) : (
              <RiAiGenerate2 className="size-4 text-primary" />
            )}
            <span className="commit-actions__label">{t('gitView.commit.generate')}</span>
          </Button>

          <div className="flex-1" />

          <Button
            size="sm"
            variant="outline"
            onClick={onCommit}
            disabled={!canCommit || isGeneratingMessage}
            className="commit-actions__btn whitespace-nowrap"
            aria-label={t('gitView.commit.commitAria')}
          >
            {commitAction === 'commit' ? (
              <>
                <RiLoader4Line className="size-4 animate-spin" />
                <span className="commit-actions__label">{t('gitView.commit.committing')}</span>
              </>
            ) : (
              <>
                <RiGitCommitLine className="size-4" />
                <span className="commit-actions__label">{t('gitView.commit.commit')}</span>
              </>
            )}
          </Button>

          {isMobile ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => onCommitAndPush()}
                  disabled={!canCommit || isGeneratingMessage}
                  className="h-7 w-7 p-0"
                  aria-label={t('gitView.commit.pushAria')}
                >
                  {commitAction === 'commitAndPush' ? (
                    <RiLoader4Line className="size-4 animate-spin" />
                  ) : (
                    <RiArrowUpLine className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{t('gitView.commit.push')}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={() => onCommitAndPush()}
              disabled={!canCommit || isGeneratingMessage}
              className="commit-actions__btn"
              aria-label={t('gitView.commit.pushAria')}
            >
              {commitAction === 'commitAndPush' ? (
                <>
                  <RiLoader4Line className="size-4 animate-spin" />
                  <span className="commit-actions__label">{t('gitView.commit.pushing')}</span>
                </>
              ) : (
                <>
                  <RiArrowUpLine className="size-3.5" />
                  <span className="commit-actions__label">{t('gitView.commit.push')}</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
};
