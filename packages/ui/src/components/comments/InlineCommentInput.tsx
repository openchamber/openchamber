import React, { useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';

export interface InlineCommentInputProps {
  initialText?: string;
  onTextChange?: (text: string) => void;
  onSave: (text: string, range?: { start: number; end: number; side?: 'additions' | 'deletions' }) => void;
  onCancel: () => void;
  fileLabel?: string;
  lineRange?: { start: number; end: number; side?: 'additions' | 'deletions' };
  isEditing?: boolean;
  className?: string;
  maxWidth?: number;
}

/**
 * The comment editor shown under selected diff/editor lines. Styled as the
 * same pill used by chat quote comments and browser annotations: a rounded
 * auto-growing textarea with a round attach button, and a muted context line
 * above naming the file and range.
 */
export function InlineCommentInput({
  initialText = '',
  onTextChange,
  onSave,
  onCancel,
  fileLabel,
  lineRange,
  isEditing = false,
  className,
  maxWidth,
}: InlineCommentInputProps) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [text, setText] = React.useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  void isEditing;

  const handleTextChange = (value: string) => {
    setText(value);
    onTextChange?.(value);
    resizeTextarea();
  };

  const resizeTextarea = () => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  };

  // Stable range snapshot to prevent race with selection clearing
  const stableRangeRef = useRef(lineRange);
  useEffect(() => {
    if (lineRange) {
      stableRangeRef.current = lineRange;
    }
  }, [lineRange]);

  const normalizeRange = (range?: { start: number; end: number; side?: 'additions' | 'deletions' }) => {
    if (!range) return undefined;
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    return { ...range, start, end };
  };

  const displayRange = normalizeRange(lineRange);

  // Focus on mount (desktop only) or when becoming visible
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    resizeTextarea();

    const scrollContainer = textarea.closest<HTMLElement>('.overlay-scrollbar-container');
    const prevScrollTop = scrollContainer?.scrollTop ?? window.scrollY;
    const prevScrollLeft = scrollContainer?.scrollLeft ?? window.scrollX;

    if (isMobile) {
      textarea.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }
      return;
    }

    try {
      textarea.focus({ preventScroll: true });
    } catch {
      textarea.focus();
    }

    const len = textarea.value.length;
    try {
      textarea.setSelectionRange(len, len);
    } catch (err) {
      void err;
    }

    requestAnimationFrame(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = prevScrollTop;
        scrollContainer.scrollLeft = prevScrollLeft;
      } else {
        window.scrollTo({ top: prevScrollTop, left: prevScrollLeft });
      }
    });
  }, [isMobile]);

  const save = () => {
    if (text.trim()) {
      onSave(text, normalizeRange(stableRangeRef.current));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // As the placeholder promises: Cmd/Ctrl+Enter attaches, plain Enter
    // breaks the line, Escape cancels.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleSaveClick = (e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    // Stop propagation to prevent parent selection clearing before save
    e.stopPropagation();
    save();
  };

  return (
    <div
      className={cn(
        'w-full max-w-[min(100%,calc(var(--oc-context-panel-width,100vw)-var(--oc-editor-gutter-width,0px)))] animate-in fade-in zoom-in-95 duration-200',
        className
      )}
      style={{
        maxWidth: maxWidth ? `${Math.max(200, Math.floor(maxWidth))}px` : undefined,
      }}
      data-comment-input="true"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className="oc-glass-popover rounded-xl border border-[var(--interactive-border)] shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]">
        {(fileLabel || displayRange) ? (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs font-medium text-[var(--surface-mutedForeground)] opacity-60">
            {fileLabel ? <span className="max-w-[200px] truncate">{fileLabel}</span> : null}
            {fileLabel && displayRange ? <span>•</span> : null}
            {displayRange ? (
              <span>{t('inlineComment.range.lines', { start: displayRange.start, end: displayRange.end })}</span>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2 py-1 pl-3 pr-1">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isMobile ? t('inlineComment.input.placeholderShort') : t('inlineComment.input.placeholder')}
          className={cn(
            'min-w-0 flex-1 resize-none bg-transparent text-sm leading-5 text-[var(--surface-foreground)] outline-none placeholder:text-[var(--surface-mutedForeground)] placeholder:opacity-60',
            isMobile ? 'py-1.5 text-base leading-6' : 'py-1.5'
          )}
          style={{ minHeight: 0, height: 'auto' }}
        />
        <button
          type="button"
          onClick={handleSaveClick}
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          disabled={!text.trim()}
          className={cn(
            'mb-0.5 flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40',
            isMobile ? 'h-9 w-9' : 'h-8 w-8'
          )}
          aria-label={t('inlineComment.actions.comment')}
          title={t('inlineComment.actions.comment')}
        >
          <Icon name="attachment-2" className="h-4 w-4" />
        </button>
        </div>
      </div>
    </div>
  );
}
