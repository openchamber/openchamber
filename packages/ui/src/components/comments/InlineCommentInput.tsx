import React, { useRef, useEffect } from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';

export interface InlineCommentInputProps {
  initialText?: string;
  onSave: (text: string, range?: { start: number; end: number; side?: 'additions' | 'deletions' }) => void;
  onCancel: () => void;
  fileLabel?: string;
  lineRange?: { start: number; end: number; side?: 'additions' | 'deletions' };
  isEditing?: boolean;
  className?: string;
  maxWidth?: number;
}

export function InlineCommentInput({
  initialText = '',
  onSave,
  onCancel,
  fileLabel,
  lineRange,
  isEditing = false,
  className,
  maxWidth,
}: InlineCommentInputProps) {
  const themeContext = useOptionalThemeSystem();
  const currentTheme = themeContext?.currentTheme;
  const { isMobile } = useDeviceInfo();
  const [text, setText] = React.useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
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

    const scrollContainer = textarea.closest('.overlay-scrollbar-container') as HTMLElement | null;
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (text.trim()) {
        onSave(text, normalizeRange(stableRangeRef.current));
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleSaveClick = (e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    // Stop propagation to prevent parent selection clearing before save
    e.stopPropagation();
    if (text.trim()) {
      onSave(text, normalizeRange(stableRangeRef.current));
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border shadow-none w-full max-w-[min(100%,calc(var(--oc-context-panel-width,100vw)-var(--oc-editor-gutter-width,0px)))] overflow-hidden animate-in fade-in zoom-in-95 duration-200",
        className
      )}
      style={{
        backgroundColor: currentTheme?.colors?.surface?.elevated,
        borderColor: currentTheme?.colors?.interactive?.border,
        maxWidth: maxWidth ? `${Math.max(200, Math.floor(maxWidth))}px` : undefined,
      }}
      data-comment-input="true"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className="p-3">
        {(fileLabel || lineRange) && (
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
            {fileLabel && <span className="truncate max-w-[200px]">{fileLabel}</span>}
            {fileLabel && lineRange && <span>•</span>}
            {displayRange && <span>Lines {displayRange.start}-{displayRange.end}</span>}
          </div>
        )}
        
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment... (Cmd+Enter to save)"
          className="min-h-[80px] text-sm resize-y"
          style={{
            backgroundColor: currentTheme?.colors?.surface?.subtle,
          }}
        />
        
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            className="h-8 text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSaveClick}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            disabled={!text.trim()}
            className="h-8 min-w-[80px]"
            style={{
              backgroundColor: currentTheme?.colors?.status?.success,
              color: currentTheme?.colors?.status?.successForeground,
            }}
          >
            {isEditing ? 'Save' : 'Comment'}
          </Button>
        </div>
      </div>
    </div>
  );
}
