import React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { collectSelectionOverlayRects } from '@/lib/selectionOverlayRects';
import { getTypeToCommentText } from '@/lib/typeToComment';
import { Icon } from '@/components/icon/Icon';
import { InlineCommentInput } from './InlineCommentInput';

interface FilePreviewCommentMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
  filePath: string;
  /** Raw file source, used to locate the selected fragment's line range. */
  fileContent: string;
}

/**
 * Comment-on-selection for read-only file previews (rendered markdown and the
 * like). Selecting text shows a small Comment pill above the selection;
 * choosing it opens the shared comment input, and attaching stores a
 * file-quote context draft carrying the selected fragment (with a best-effort
 * source line range) plus the user's comment.
 */
export function FilePreviewCommentMenu({ containerRef, filePath, fileContent }: FilePreviewCommentMenuProps) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const effectiveDirectory = useEffectiveDirectory();
  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);

  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const [selectedText, setSelectedText] = React.useState('');
  const [commentMode, setCommentMode] = React.useState(false);
  const [initialCommentText, setInitialCommentText] = React.useState('');
  const commentModeRef = React.useRef(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const selectionRangeRef = React.useRef<Range | null>(null);
  // The selected fragment stays visibly highlighted while the comment input
  // owns focus, same as chat quote comments.
  const [highlightRects, setHighlightRects] = React.useState<DOMRect[] | null>(null);

  const hide = React.useCallback(() => {
    setAnchor(null);
    setSelectedText('');
    setCommentMode(false);
    commentModeRef.current = false;
    selectionRangeRef.current = null;
    setHighlightRects(null);
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleSelectionChange = () => {
      if (commentModeRef.current) return;
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!selection || !text || selection.rangeCount === 0) {
        hide();
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        hide();
        return;
      }
      const rect = range.getBoundingClientRect();
      selectionRangeRef.current = range.cloneRange();
      setSelectedText(text);
      setAnchor({ x: rect.left + rect.width / 2, y: rect.top - 10 });
    };

    const handlePointerDown = (event: PointerEvent) => {
      // SAFETY: a pointer event target inside the document is always a Node;
      // `contains` only needs that.
      if (menuRef.current?.contains(event.target as Node)) return;
      if (commentModeRef.current) {
        hide();
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [containerRef, hide]);

  /**
   * Best-effort mapping of the rendered-text selection back to source lines:
   * an exact match of the fragment (or its first line) in the raw content
   * yields a range; markdown syntax usually breaks the match, in which case
   * the draft simply carries no line numbers.
   */
  const resolveLineRange = React.useCallback((fragment: string): { start: number; end: number } | null => {
    const lineAt = (index: number): number => fileContent.slice(0, index).split('\n').length;
    // Inline markdown syntax (emphasis markers and such) breaks long matches,
    // so each anchor line is tried at decreasing lengths.
    const candidatesFor = (line: string): string[] => {
      const trimmed = line.trim();
      return [trimmed, trimmed.slice(0, 32), trimmed.split(' ').slice(0, 4).join(' ')]
        .filter((candidate) => candidate.length >= 8);
    };
    const locate = (line: string, from: number): number => {
      for (const candidate of candidatesFor(line)) {
        const index = fileContent.indexOf(candidate, from);
        if (index >= 0) return index;
      }
      return -1;
    };

    const exact = fragment.length >= 8 ? fileContent.indexOf(fragment) : -1;
    if (exact >= 0) {
      const start = lineAt(exact);
      return { start, end: start + fragment.split('\n').length - 1 };
    }

    const fragmentLines = fragment.split('\n').map((line) => line.trim()).filter(Boolean);
    if (fragmentLines.length === 0) return null;
    const startIndex = locate(fragmentLines[0], 0);
    if (startIndex < 0) return null;
    const start = lineAt(startIndex);
    if (fragmentLines.length === 1) return { start, end: start };
    const endIndex = locate(fragmentLines[fragmentLines.length - 1], startIndex);
    // A partially located multi-line fragment gets no range rather than a
    // misleading single-line one.
    if (endIndex < 0) return null;
    return { start, end: Math.max(start, lineAt(endIndex)) };
  }, [fileContent]);

  const updateHighlightRects = React.useCallback(() => {
    const range = selectionRangeRef.current;
    if (!range) {
      setHighlightRects(null);
      return;
    }
    setHighlightRects(collectSelectionOverlayRects(range));
  }, []);

  React.useEffect(() => {
    if (!commentMode) return;
    let frame: number | null = null;
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateHighlightRects();
      });
    };
    document.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', scheduleUpdate, { capture: true });
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [commentMode, updateHighlightRects]);

  const openComment = React.useCallback((initialText: string) => {
    if (!selectedText) return;
    setInitialCommentText(initialText);
    setCommentMode(true);
    commentModeRef.current = true;
    updateHighlightRects();
    window.getSelection()?.removeAllRanges();
  }, [selectedText, updateHighlightRects]);

  // Desktop: typing while the Comment pill is up starts the comment with
  // that keystroke, same as the chat selection bubble.
  React.useEffect(() => {
    if (!anchor || commentMode || isMobile) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const text = getTypeToCommentText(event);
      if (!text) return;
      event.preventDefault();
      openComment(text);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [anchor, commentMode, isMobile, openComment]);

  const saveComment = React.useCallback((text: string) => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!selectedText || !sessionKey || !effectiveDirectory) {
      hide();
      return;
    }
    const lineRange = resolveLineRange(selectedText);
    addDraft({ directory: effectiveDirectory, sessionKey }, {
      source: 'file-quote',
      fileLabel: filePath,
      startLine: lineRange?.start ?? 0,
      endLine: lineRange?.end ?? 0,
      code: selectedText,
      language: '',
      text: text.trim(),
    });
    hide();
    queueMicrotask(() => {
      focusChatInput();
    });
  }, [addDraft, currentSessionId, effectiveDirectory, filePath, hide, newSessionDraftOpen, resolveLineRange, selectedText]);

  if (!anchor) return null;

  const lineRange = commentMode ? resolveLineRange(selectedText) : null;

  const highlightOverlay = commentMode && highlightRects && highlightRects.length > 0
    ? (
      <div className="pointer-events-none fixed inset-0 z-40">
        {highlightRects.map((rect, index) => (
          <div
            key={index}
            className="oc-chat-comment-rect absolute"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        ))}
      </div>
    )
    : null;

  const commentInput = (
    <InlineCommentInput
      initialText={initialCommentText}
      fileLabel={filePath}
      lineRange={lineRange ? { start: lineRange.start, end: lineRange.end } : undefined}
      onSave={saveComment}
      onCancel={hide}
    />
  );

  // Mobile: Android and iOS draw their own copy/paste toolbar right above a
  // text selection, exactly where the desktop pill sits, and cover it (#3894).
  // So the Comment button and the comment input dock at the bottom of the
  // screen instead, like the chat selection sheet; the keyboard-inset surface
  // keeps the input above the soft keyboard in the native app, and the
  // browser's resizes-content viewport does the same on the web. The
  // highlight renders inside this layer: on mobile the files panel is itself a
  // z-50 overlay and would cover a separate body-level highlight.
  if (isMobile) {
    return createPortal(
      <div className="oc-keyboard-inset-surface pointer-events-none fixed inset-x-0 bottom-0 z-50">
        {highlightOverlay}
        <div
          ref={menuRef}
          className="pointer-events-auto mx-auto max-w-[420px] px-3"
          style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {commentMode ? commentInput : (
            <div
              className={cn(
                'mx-auto w-fit',
                'oc-glass-popover rounded-full border border-[var(--interactive-border)]',
                'p-1 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
              )}
            >
              <button
                type="button"
                // Keep the text selection alive through the tap: the
                // selection is what the comment quotes.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => openComment('')}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-full px-4 py-2',
                  'text-sm font-medium leading-tight text-foreground',
                  'active:bg-[var(--interactive-hover)]',
                  'transition-colors duration-150'
                )}
                title={t('chat.textSelection.title.commentOnSelection')}
              >
                <Icon name="chat-1" className="size-4 flex-shrink-0" />
                <span className="min-w-0 whitespace-nowrap">{t('chat.textSelection.actions.comment')}</span>
              </button>
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50"
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      {highlightOverlay ? createPortal(highlightOverlay, document.body) : null}
      {commentMode ? (
        <div className="w-[min(420px,80vw)]">
          {commentInput}
        </div>
      ) : (
        <div
          className={cn(
            'flex items-center whitespace-nowrap',
            'oc-glass-popover rounded-full border border-[var(--interactive-border)]',
            'shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
            'p-1',
          )}
        >
          <button
            type="button"
            onClick={() => openComment('')}
            className={cn(
              'px-3.5 py-1.5 rounded-full',
              'text-sm font-medium',
              'text-foreground',
              'hover:bg-[var(--interactive-hover)]',
              'transition-colors duration-150'
            )}
            title={t('chat.textSelection.title.commentOnSelection')}
          >
            {t('chat.textSelection.actions.comment')}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
