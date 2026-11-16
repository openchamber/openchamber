import React from 'react';

import { toast } from '@/components/ui';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { collectSelectionOverlayRects } from '@/lib/selectionOverlayRects';
import { getTypeToCommentText } from '@/lib/typeToComment';
import { InlineCommentInput } from './InlineCommentInput';
import { SelectionCommentPopup } from './SelectionCommentPopup';

interface FilePreviewCommentMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
  filePath: string;
  fileContent: string;
}

export function FilePreviewCommentMenu({ containerRef, filePath, fileContent }: FilePreviewCommentMenuProps) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const effectiveDirectory = useEffectiveDirectory();
  const target = useComposerDraftTarget(effectiveDirectory);
  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);

  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const [selectedText, setSelectedText] = React.useState('');
  const [commentMode, setCommentMode] = React.useState(false);
  const [initialCommentText, setInitialCommentText] = React.useState('');
  const commentModeRef = React.useRef(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const selectionRangeRef = React.useRef<Range | null>(null);
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

  const resolveLineRange = React.useCallback((fragment: string): { start: number; end: number } | null => {
    const lineAt = (index: number): number => fileContent.slice(0, index).split('\n').length;
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
    if (!selectedText || !target) {
      hide();
      return true;
    }
    const lineRange = resolveLineRange(selectedText);
    const draftId = addDraft(target, {
      source: 'file-quote',
      fileLabel: filePath,
      startLine: lineRange?.start ?? 0,
      endLine: lineRange?.end ?? 0,
      code: selectedText,
      language: '',
      text: text.trim(),
    });
    if (!draftId) {
      toast.error(t('inlineComment.toast.noRoom'));
      return false;
    }
    hide();
    queueMicrotask(() => {
      focusChatInput();
    });
    return true;
  }, [addDraft, filePath, hide, resolveLineRange, selectedText, t, target]);

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
      floating
    />
  );

  return (
    <SelectionCommentPopup
      anchor={anchor}
      commentMode={commentMode}
      commentInput={commentInput}
      highlightOverlay={highlightOverlay}
      menuRef={menuRef}
      onComment={() => openComment('')}
    />
  );
}
