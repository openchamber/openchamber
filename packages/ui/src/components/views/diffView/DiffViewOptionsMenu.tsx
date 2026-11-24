import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { ToolbarButton } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';
import { useToolbarStep } from '@/hooks/useToolbarStep';
import type { DiffViewMode } from '@/components/chat/message/types';

interface DiffViewOptionsMenuProps {
  diffWrapLines: boolean;
  onToggleWrapLines: () => void;
  diffHideWhitespace: boolean;
  onToggleHideWhitespace: () => void;
  currentLayoutForAllFiles: 'inline' | 'side-by-side' | null;
  onLayoutChange: (mode: DiffViewMode) => void;
  showExpandCollapseAll?: boolean;
  anyExpanded?: boolean;
  onToggleExpandCollapseAll?: () => void;
  showWalkthrough?: boolean;
  onOpenWalkthrough?: () => void;
  foldedReview?: {
    toolbarRef: React.RefObject<HTMLElement | null>;
    step: string;
    onStartReview?: () => void;
    reviewSubmitting?: boolean;
    onOpenWalkthrough?: () => void;
  };
}

export const DiffViewOptionsMenu: React.FC<DiffViewOptionsMenuProps> = ({
  diffWrapLines,
  onToggleWrapLines,
  diffHideWhitespace,
  onToggleHideWhitespace,
  currentLayoutForAllFiles,
  onLayoutChange,
  showExpandCollapseAll = false,
  anyExpanded = false,
  onToggleExpandCollapseAll,
  showWalkthrough = false,
  onOpenWalkthrough,
  foldedReview,
}) => {
  const { t } = useI18n();
  const sideBySide = currentLayoutForAllFiles === 'side-by-side';
  const [menuOpen, setMenuOpen] = React.useState(false);
  const reviewFolded = useToolbarStep(foldedReview?.toolbarRef, foldedReview?.step ?? '', menuOpen && Boolean(foldedReview));
  const folded = reviewFolded && foldedReview ? foldedReview : null;
  const walkthroughItem = showWalkthrough && onOpenWalkthrough ? onOpenWalkthrough : folded?.onOpenWalkthrough;

  return (
    <DropdownMenu onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="diff-toolbar__more flex-shrink-0">
            <DropdownMenuTrigger asChild>
              <ToolbarButton label={t('diffView.actions.viewOptions')} icon="equalizer-2" />
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{t('diffView.actions.viewOptions')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        {folded?.onStartReview ? (
          <DropdownMenuItem className="flex items-center gap-2" disabled={folded.reviewSubmitting} onClick={folded.onStartReview}>
            <Icon name={folded.reviewSubmitting ? 'loader-4' : 'search-eye'} className={folded.reviewSubmitting ? 'size-4 animate-spin' : 'size-4'} />
            <span className="min-w-0 truncate typography-ui-label text-foreground">{t('chat.work.reviewHint.aiReview')}</span>
          </DropdownMenuItem>
        ) : null}
        {walkthroughItem ? (
          <DropdownMenuItem className="flex items-center gap-2" onClick={walkthroughItem}>
            <Icon name="route" className="size-4" />
            <span className="min-w-0 truncate typography-ui-label text-foreground">{t('walkthrough.action.open')}</span>
          </DropdownMenuItem>
        ) : null}
        {walkthroughItem || folded?.onStartReview ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem className="flex items-center gap-2" onClick={onToggleWrapLines}>
          <Icon name="text-wrap" className="size-4" />
          <span className="min-w-0 truncate typography-ui-label text-foreground">{t('diffView.actions.wrapLines')}</span>
          {diffWrapLines ? <Icon name="check" className="ms-auto size-4 text-foreground" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem className="flex items-center gap-2" onClick={onToggleHideWhitespace}>
          <Icon name="space" className="size-4" />
          <span className="min-w-0 truncate typography-ui-label text-foreground">{t('diffView.actions.hideWhitespace')}</span>
          {diffHideWhitespace ? <Icon name="check" className="ms-auto size-4 text-foreground" /> : null}
        </DropdownMenuItem>
        {currentLayoutForAllFiles ? (
          <DropdownMenuItem
            className="flex items-center gap-2"
            onClick={() => onLayoutChange(sideBySide ? 'unified' : 'side-by-side')}
          >
            <Icon name="layout-column" className="size-4" />
            <span className="min-w-0 truncate typography-ui-label text-foreground">{t('diffView.layout.sideBySide')}</span>
            {sideBySide ? <Icon name="check" className="ms-auto size-4 text-foreground" /> : null}
          </DropdownMenuItem>
        ) : null}
        {showExpandCollapseAll && onToggleExpandCollapseAll ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="flex items-center gap-2" onClick={onToggleExpandCollapseAll}>
              <Icon name="expand-up-down" className="size-4" />
              <span className="min-w-0 truncate typography-ui-label text-foreground">
                {anyExpanded ? t('diffView.actions.collapseAll') : t('diffView.actions.expandAll')}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
