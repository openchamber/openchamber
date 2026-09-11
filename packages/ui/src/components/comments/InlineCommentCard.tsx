import React, { useState } from 'react';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

interface InlineCommentCardProps {
  draft: InlineCommentDraft;
  onEdit: () => void;
  onDelete: () => void;
  className?: string;
  maxWidth?: number;
}

const HEADER_ACTION_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]';

/**
 * A saved inline comment shown under its lines in the diff/editor. Styled to
 * match the composer's context preview entries: a muted header band naming
 * the file and range with direct edit/remove actions, and the comment text
 * below.
 */
export function InlineCommentCard({
  draft,
  onEdit,
  onDelete,
  className,
  maxWidth,
}: InlineCommentCardProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const draftText = draft.text;

  // Check if content is long enough to warrant collapsing (rough estimate)
  const isLongContent = draftText.length > 150 || draftText.split('\n').length > 3;

  return (
    <div
      className={cn(
        'w-full max-w-[min(100%,calc(var(--oc-context-panel-width,100vw)-var(--oc-editor-gutter-width,0px)))] overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-none',
        className
      )}
      style={{
        maxWidth: maxWidth ? `${Math.max(200, Math.floor(maxWidth))}px` : undefined,
      }}
      data-comment-card="true"
    >
      <div
        className="flex items-center gap-1.5 px-3 py-1.5"
        style={{ backgroundColor: 'color-mix(in srgb, var(--surface-mutedForeground) 8%, transparent)' }}
      >
        <span className="min-w-0 max-w-[200px] truncate text-xs font-medium text-[var(--surface-foreground)]" title={draft.fileLabel}>
          {draft.fileLabel}
        </span>
        <span className="text-xs text-[var(--surface-mutedForeground)]">•</span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--surface-mutedForeground)]">
          {t('inlineComment.range.lines', { start: draft.startLine, end: draft.endLine })}
          {draft.side ? ` (${draft.side})` : ''}
        </span>
        <button
          type="button"
          className={HEADER_ACTION_CLASS}
          style={{ minHeight: 0, minWidth: 0 }}
          onClick={onEdit}
          aria-label={t('inlineComment.actions.editComment')}
          title={t('inlineComment.actions.editComment')}
        >
          <Icon name="pencil" className="h-3 w-3" />
        </button>
        <button
          type="button"
          className={HEADER_ACTION_CLASS}
          style={{ minHeight: 0, minWidth: 0 }}
          onClick={onDelete}
          aria-label={t('inlineComment.actions.deleteComment')}
          title={t('inlineComment.actions.deleteComment')}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      </div>

      <div className="px-3 py-2">
        <Collapsible open={isOpen || !isLongContent} onOpenChange={setIsOpen}>
          <div className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--surface-foreground)]', !isOpen && isLongContent && 'line-clamp-3')}>
            {draftText}
          </div>

          {isLongContent && (
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 w-full justify-start px-0 text-xs text-muted-foreground hover:text-foreground"
              >
                {isOpen ? (
                  <>
                    <Icon name="arrow-up-s" className="mr-1 size-3" />
                    {t('inlineComment.actions.showLess')}
                  </>
                ) : (
                  <>
                    <Icon name="arrow-down-s" className="mr-1 size-3" />
                    {t('inlineComment.actions.showMore')}
                  </>
                )}
              </Button>
            </CollapsibleTrigger>
          )}

          <CollapsibleContent>
            {/* Used for animation purposes if we want to animate height */}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
