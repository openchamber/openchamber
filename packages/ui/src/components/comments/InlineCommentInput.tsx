import React, { useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { CommentTextEditor } from './CommentTextEditor';
import { useCommentImagePaste } from './useCommentImagePaste';

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
 * auto-growing field with a round attach button, and a muted context line
 * above naming the file and range. Keys, image paste and snippets live in
 * `CommentTextEditor`.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const saveShortcut = formatShortcutForDisplay('enter');
  void isEditing;

  const handleTextChange = (value: string) => {
    setText(value);
    onTextChange?.(value);
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

  // The field focuses itself without scrolling; on mobile bring the card
  // into view above the keyboard.
  useEffect(() => {
    if (isMobile) rootRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [isMobile]);

  const imagePaste = useCommentImagePaste();

  const save = () => {
    if (text.trim()) {
      onSave(text, normalizeRange(stableRangeRef.current));
      void imagePaste.attachCitedImages(text);
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
        // The glass card's shadow lives here, off its backdrop-filter element.
        'rounded-xl shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
        className
      )}
      style={{
        maxWidth: maxWidth ? `${Math.max(200, Math.floor(maxWidth))}px` : undefined,
      }}
      ref={rootRef}
      data-comment-input="true"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className="oc-glass-popover rounded-xl border border-[var(--interactive-border)]">
        {(fileLabel || displayRange) ? (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs font-medium text-muted-foreground opacity-60">
            {fileLabel ? <span className="max-w-[200px] truncate">{fileLabel}</span> : null}
            {fileLabel && displayRange ? <span>•</span> : null}
            {displayRange ? (
              <span>{t('inlineComment.range.lines', { start: displayRange.start, end: displayRange.end })}</span>
            ) : null}
          </div>
        ) : null}
        <div className="relative flex items-end gap-2 py-1 pl-3 pr-1">
        <CommentTextEditor
          value={text}
          onChange={handleTextChange}
          onSubmit={save}
          onCancel={onCancel}
          // Desktop Enter attaches; Shift+Enter and mobile Enter break the line.
          // Cmd/Ctrl+Enter stays available for hardware keyboards on mobile.
          enterSubmits={!isMobile}
          imagePaste={imagePaste}
          placeholder={isMobile
            ? t('inlineComment.input.placeholderShort')
            : t('inlineComment.input.placeholder', { shortcut: saveShortcut })}
          className={cn('py-1.5 text-sm leading-5 text-foreground', isMobile && 'text-base leading-6')}
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
