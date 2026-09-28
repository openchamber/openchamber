import React from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessions } from '@/sync/sync-context';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { PROJECT_NOTE_BODY_MAX_LENGTH } from '@/lib/projectContextApi';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { summarizeSelectionForNotes } from '@/lib/smallModel';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import {
    useMobileCommentComposerController,
    useMobileCommentDraft,
} from '../composer/comment/MobileCommentComposerContext';
import { rangeToMarkdown, trimSelectionValue, wrapMarkdownSelectionForChat } from './selectionMarkdown';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { registerActiveSelectionToolbar } from '@/lib/addSelectionToChat';
import { collectSelectionOverlayRects } from '@/lib/selectionOverlayRects';
import { captureChatQuoteAnchor, type ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import {
  DESKTOP_MENU_FALLBACK_HEIGHT_PX,
  DESKTOP_MENU_FALLBACK_WIDTH_PX,
  getDesktopClampedX,
  getDesktopMenuY,
  type DesktopMenuPlacement,
} from './selectionMenuPosition';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
}

interface MenuPosition {
  x: number;
  y: number;
  placement: DesktopMenuPlacement;
  show: boolean;
}

interface SelectionPayload {
  plainText: string;
  markdownText: string;
  rect: DOMRect;
  messageId: string | null;
  range: Range;
}

const normalizeDistilledInsight = (insight: string): string => (
  insight.trim().replace(/^[-*+]\s+/, '').slice(0, PROJECT_NOTE_BODY_MAX_LENGTH)
);

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef }) => {
  const { t } = useI18n();
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, placement: 'above', show: false });
  // False while the chat has scrolled the selection out of view; the menu
  // waits hidden instead of pinning itself to an edge.
  const [anchorVisible, setAnchorVisible] = React.useState(true);
  const [selectedText, setSelectedText] = React.useState('');
  const [selectedTextMarkdown, setSelectedTextMarkdown] = React.useState('');
  const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(null);
  const [selectedAnchor, setSelectedAnchor] = React.useState<ChatQuoteAnchor | null>(null);
  const [commentMode, setCommentMode] = React.useState(false);
  const commentModeRef = React.useRef(false);
  const [commentText, setCommentText] = React.useState('');
  const commentInputRef = React.useRef<HTMLTextAreaElement>(null);

  // While the comment input owns focus the native selection is gone, so the
  // quoted fragment is repainted with our own overlay rectangles. Raw
  // Range.getClientRects() mixes block-container boxes with text boxes and
  // the translucent overlaps paint double-dark bands, so the rects are taken
  // from the text nodes only and merged into one strip per visual line.
  const [commentRects, setCommentRects] = React.useState<DOMRect[] | null>(null);
  const updateCommentRects = React.useCallback(() => {
    const range = pendingSelectionRef.current?.range;
    if (!range) {
      setCommentRects(null);
      return;
    }

    setCommentRects(collectSelectionOverlayRects(range));
  }, []);

  React.useEffect(() => {
    if (!commentMode) return;
    let frame: number | null = null;
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateCommentRects();
      });
    };
    document.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', scheduleUpdate, { capture: true });
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [commentMode, updateCommentRects]);

  // Grow the comment box with its content, up to five lines.
  const resizeCommentInput = React.useCallback(() => {
    const element = commentInputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, []);
  const isDraggingRef = React.useRef(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const [isAddingToNotes, setIsAddingToNotes] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuWidthRef = React.useRef(DESKTOP_MENU_FALLBACK_WIDTH_PX);
  const menuHeightRef = React.useRef(DESKTOP_MENU_FALLBACK_HEIGHT_PX);
  const anchorRectRef = React.useRef<DOMRect | null>(null);
  const pendingSelectionRef = React.useRef<SelectionPayload | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const mouseUpTimeoutRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);
  const activeAddToChatCleanupRef = React.useRef<(() => void) | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addContextDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
  const requestBtwComposer = useInputStore((state) => state.requestBtwComposer);
  const isMobile = useUIStore((state) => state.isMobile);
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const effectiveDirectory = useEffectiveDirectory();
  const sessions = useSessions();
  const mobileCommentController = useMobileCommentComposerController();
  const mobileCommentDraft = useMobileCommentDraft(mobileCommentController);
  const mobileCommentActive = mobileCommentDraft.status === 'open';

  React.useEffect(() => {
    isMenuVisibleRef.current = position.show;
  }, [position.show]);

  React.useEffect(() => {
    return () => {
      activeAddToChatCleanupRef.current?.();
      activeAddToChatCleanupRef.current = null;
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
        mouseUpTimeoutRef.current = null;
      }
    };
  }, []);

  const hideMenu = React.useCallback(() => {
    pendingSelectionRef.current = null;
    anchorRectRef.current = null;
    activeAddToChatCleanupRef.current?.();
    activeAddToChatCleanupRef.current = null;
    setCommentRects(null);

    if (!isMenuVisibleRef.current) {
      return;
    }

    if (openRafRef.current !== null) {
      window.cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    setIsOpening(false);

    setPosition((prev) => ({ ...prev, show: false }));
    setAnchorVisible(true);
    setSelectedText('');
    setSelectedTextMarkdown('');
    setSelectedMessageId(null);
    setSelectedAnchor(null);
    setCommentMode(false);
    commentModeRef.current = false;
    setCommentText('');
    isMenuVisibleRef.current = false;
  }, []);

  // Listener-facing mirror of the composer's comment state: the document
  // listeners below must not clear the quote highlight for taps inside the
  // comment shell, which lives outside this menu's DOM.
  const mobileCommentActiveRef = React.useRef(false);
  React.useEffect(() => {
    mobileCommentActiveRef.current = mobileCommentActive;
    // The composer ended the comment (attach, cancel, or a scope change):
    // drop the highlight overlay and the retained range with it.
    if (!mobileCommentActive && isMobile && commentModeRef.current) {
      hideMenu();
    }
  }, [hideMenu, isMobile, mobileCommentActive]);

  // The boundary is the scroller holding the message (the chat, or the btw
  // panel body), not the message itself: bounding by the message pushed the
  // menu onto selections in its first lines (#3596).
  const getDesktopPosition = React.useCallback((rect: DOMRect) => {
    const boundary = containerRef.current?.closest('[data-scrollbar="chat"], [data-selection-menu-boundary]');
    const { y, placement } = getDesktopMenuY({
      selectionTop: rect.top,
      selectionBottom: rect.bottom,
      menuHeight: menuHeightRef.current,
      viewportHeight: window.innerHeight,
      boundaryTop: boundary ? boundary.getBoundingClientRect().top : 0,
    });
    return {
      x: getDesktopClampedX(rect.left + rect.width / 2, window.innerWidth, menuWidthRef.current),
      y,
      placement,
    };
  }, [containerRef]);

  const addMarkdownToChat = React.useCallback((markdownText: string) => {
    const markdownBlock = wrapMarkdownSelectionForChat(markdownText);
    setPendingInputText(markdownBlock, 'append');

    hideMenu();

    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      focusChatInput();
    });
  }, [hideMenu, setPendingInputText]);

  const showMenu = React.useCallback(() => {
    if (!pendingSelectionRef.current) return;

    const { plainText, markdownText, rect, messageId } = pendingSelectionRef.current;
    const shouldAnimateIn = !position.show;

    activeAddToChatCleanupRef.current?.();
    activeAddToChatCleanupRef.current = registerActiveSelectionToolbar({
      addToChat: () => addMarkdownToChat(markdownText),
      dismiss: hideMenu,
    });

    anchorRectRef.current = rect;

    setSelectedText(plainText);
    setSelectedTextMarkdown(markdownText);
    setSelectedMessageId(messageId);
    // Mobile renders a bottom bar and ignores the coordinates.
    setPosition(isMobile
      ? { x: 0, y: 0, placement: 'above', show: true }
      : { ...getDesktopPosition(rect), show: true });
    isMenuVisibleRef.current = true;

    if (shouldAnimateIn) {
      setIsOpening(true);
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
      }
      openRafRef.current = window.requestAnimationFrame(() => {
        setIsOpening(false);
        openRafRef.current = null;
      });
    }
  }, [addMarkdownToChat, getDesktopPosition, hideMenu, isMobile, position.show]);

  React.useLayoutEffect(() => {
    if (!position.show || isMobile || !menuRef.current) {
      return;
    }

    const measuredWidth = menuRef.current.offsetWidth;
    const measuredHeight = menuRef.current.offsetHeight;
    const widthChanged = Number.isFinite(measuredWidth) && measuredWidth > 0 && measuredWidth !== menuWidthRef.current;
    const heightChanged = Number.isFinite(measuredHeight) && measuredHeight > 0 && measuredHeight !== menuHeightRef.current;
    if (!widthChanged && !heightChanged) {
      return;
    }

    if (widthChanged) {
      menuWidthRef.current = measuredWidth;
    }
    if (heightChanged) {
      menuHeightRef.current = measuredHeight;
    }
    const rect = anchorRectRef.current;
    if (rect) {
      setPosition((prev) => ({ ...prev, ...getDesktopPosition(rect) }));
    }
    // Entering comment mode and typing into the comment box both grow the
    // popup, so remeasuring on those keeps the cached size (and the placement
    // built from it) honest.
  }, [commentMode, commentText, getDesktopPosition, isMobile, position.show]);

  // Desktop: the menu (and the comment input) ride along with the selection
  // while the chat scrolls. Only the one open menu listens.
  React.useEffect(() => {
    if (!position.show || isMobile) {
      return;
    }
    let frame: number | null = null;
    const follow = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const range = pendingSelectionRef.current?.range;
        if (!range) return;
        const rect = range.getBoundingClientRect();
        anchorRectRef.current = rect;
        const boundary = containerRef.current
          ?.closest('[data-scrollbar="chat"], [data-selection-menu-boundary]')
          ?.getBoundingClientRect();
        setAnchorVisible(!boundary || (rect.bottom > boundary.top && rect.top < boundary.bottom));
        const next = getDesktopPosition(rect);
        setPosition((prev) => (
          prev.x === next.x && prev.y === next.y && prev.placement === next.placement
            ? prev
            : { ...prev, ...next }
        ));
      });
    };
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', follow, { capture: true });
    };
  }, [containerRef, getDesktopPosition, isMobile, position.show]);

  React.useEffect(() => {
    if (!position.show || isMobile) {
      return;
    }

    const handleViewportResize = () => {
      const rect = anchorRectRef.current;
      if (!rect) return;
      setPosition((prev) => ({ ...prev, ...getDesktopPosition(rect) }));
    };

    window.addEventListener('resize', handleViewportResize);
    return () => {
      window.removeEventListener('resize', handleViewportResize);
    };
  }, [getDesktopPosition, isMobile, position.show]);

  const handleSelectionChange = React.useCallback(() => {
    // While the comment input is open, clicking or typing in it collapses the
    // text selection; the captured quote must survive that.
    if (commentModeRef.current) {
      return;
    }
    const selection = window.getSelection();
    const container = containerRef.current;

    if (!selection || !container) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    const text = trimSelectionValue(selection.toString());

    // Only show if we have text and the selection is within our container
    if (!text) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    // Check if selection is within the container
    const range = selection.getRangeAt(0);
    
    if (!container.contains(range.commonAncestorContainer)) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    // Get selection coordinates
    const rect = range.getBoundingClientRect();

    // Store the selection but don't show menu yet if dragging
    const anchorElement = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    pendingSelectionRef.current = {
      plainText: text,
      markdownText: rangeToMarkdown(range, text),
      rect,
      messageId: anchorElement?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null,
      range: range.cloneRange(),
    };

    // Only show menu if we're not currently dragging
    if (!isDraggingRef.current) {
      showMenu();
    }
  }, [containerRef, hideMenu, showMenu]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Track when dragging starts
    const handleMouseDown = (event: MouseEvent) => {
      // SAFETY: a MouseEvent target inside the document is always a Node;
      // `contains` only needs that.
      if (commentModeRef.current && menuRef.current?.contains(event.target as Node)) {
        return;
      }
      // The composer's comment mode owns the selection: taps anywhere —
      // including the transcript — keep the quote highlight until the
      // comment ends.
      if (mobileCommentActiveRef.current) {
        return;
      }
      isDraggingRef.current = true;
      hideMenu();
    };

    // Track when dragging stops
    const handleMouseUp = () => {
      isDraggingRef.current = false;
      // Check if we have a pending selection to show
      if (pendingSelectionRef.current) {
        if (mouseUpTimeoutRef.current !== null) {
          window.clearTimeout(mouseUpTimeoutRef.current);
        }
        // Small delay to ensure selection is finalized
        mouseUpTimeoutRef.current = window.setTimeout(() => {
          mouseUpTimeoutRef.current = null;
          // The click that opened the comment input cleared the selection on
          // purpose; the input must survive this deferred check.
          if (commentModeRef.current) {
            return;
          }
          const selection = window.getSelection();
          if (selection && selection.toString().trim()) {
            showMenu();
          } else {
            hideMenu();
          }
        }, 10);
      }
    };

    // Listen for selection changes during drag
    document.addEventListener('selectionchange', handleSelectionChange);
    
    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);

    // Hide menu when clicking outside
    const handleClickOutside = (e: MouseEvent) => {
      // The comment shell and its voice overlay sit outside this menu; taps
      // there must not clear the quote highlight.
      if (mobileCommentActiveRef.current) {
        return;
      }
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        (commentModeRef.current || !window.getSelection()?.toString().trim())
      ) {
        hideMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      if (mouseUpTimeoutRef.current !== null) {
        window.clearTimeout(mouseUpTimeoutRef.current);
        mouseUpTimeoutRef.current = null;
      }
      document.removeEventListener('selectionchange', handleSelectionChange);
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [containerRef, handleSelectionChange, hideMenu, showMenu]);

  const handleAddToChat = React.useCallback(() => {
    if (!selectedTextMarkdown) return;
    addMarkdownToChat(selectedTextMarkdown);
  }, [addMarkdownToChat, selectedTextMarkdown]);

  const handleAskOpenChamber = React.useCallback(() => {
    if (!currentSessionId || !selectedTextMarkdown) return;
    requestBtwComposer({
      parentSessionId: currentSessionId,
      text: wrapMarkdownSelectionForChat(selectedTextMarkdown),
    });
    hideMenu();
    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      focusChatInput();
    });
  }, [currentSessionId, hideMenu, requestBtwComposer, selectedTextMarkdown]);

  // Taken once the user commits to commenting, not on every selectionchange:
  // it reads the whole message text.
  const captureCommentAnchor = React.useCallback((): ChatQuoteAnchor | null => {
    const container = containerRef.current;
    const range = pendingSelectionRef.current?.range;
    return container && range ? captureChatQuoteAnchor(container, range) : null;
  }, [containerRef]);

  const handleOpenComment = React.useCallback(() => {
    if (!selectedTextMarkdown) return;
    setSelectedAnchor(captureCommentAnchor());
    setCommentMode(true);
    commentModeRef.current = true;
    updateCommentRects();
    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      commentInputRef.current?.focus();
    });
  }, [captureCommentAnchor, selectedTextMarkdown, updateCommentRects]);

  // Mobile: no floating input here. The quote is handed to this column's
  // composer, which swaps its input for the comment shell. The scope is
  // captured from the visible composer, including BTW. Switching its target
  // closes the comment instead of re-targeting. The menu keeps the quoted range
  // highlighted until the comment ends.
  // flushSync mounts and focuses the comment editor while the tap's call
  // stack is still live; that synchronous focus is the only one iOS raises
  // the soft keyboard for.
  const handleOpenMobileComment = React.useCallback(() => {
    if (!selectedTextMarkdown) return;
    if (!mobileCommentController) {
      hideMenu();
      return;
    }
    const quote = {
      plainText: selectedText,
      markdownText: selectedTextMarkdown,
      messageId: selectedMessageId,
      anchor: captureCommentAnchor(),
    };
    setCommentMode(true);
    commentModeRef.current = true;
    updateCommentRects();
    window.getSelection()?.removeAllRanges();
    const opened = flushSync(() => (
      mobileCommentController.open(quote)
    ));
    if (!opened) {
      hideMenu();
    }
  }, [captureCommentAnchor, hideMenu, mobileCommentController, selectedMessageId, selectedText, selectedTextMarkdown, updateCommentRects]);

  const handleAttachComment = React.useCallback(() => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!selectedTextMarkdown || !sessionKey || !effectiveDirectory) {
      hideMenu();
      return;
    }
    const draftId = addContextDraft({ directory: effectiveDirectory, sessionKey }, {
      source: 'chat-quote',
      fileLabel: selectedMessageId ?? '',
      startLine: 1,
      endLine: 1,
      code: selectedTextMarkdown,
      language: '',
      text: commentText.trim(),
      anchor: selectedAnchor ?? undefined,
    });
    if (!draftId) {
      toast.error(t('chat.textSelection.comment.attachFailed'));
      return;
    }
    hideMenu();
    queueMicrotask(() => {
      focusChatInput();
    });
  }, [addContextDraft, commentText, currentSessionId, effectiveDirectory, hideMenu, newSessionDraftOpen, selectedAnchor, selectedMessageId, selectedTextMarkdown, t]);

  const currentSession = React.useMemo(() => {
    if (!currentSessionId) {
      return null;
    }
    return sessions.find((session) => session.id === currentSessionId) ?? null;
  }, [currentSessionId, sessions]);

  const currentProjectRef = React.useMemo(() => {
    const directory = effectiveDirectory
      ?? (typeof currentSession?.directory === 'string' ? currentSession.directory : '');
    const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return resolved ? { id: resolved.id, path: resolved.path } : null;
  }, [availableWorktreesByProject, currentSession?.directory, effectiveDirectory, projects]);

  const handleAddToNotes = React.useCallback(async () => {
    if (!selectedText || !currentProjectRef) {
      if (!currentProjectRef) {
        toast.error(t('chat.textSelection.toast.noProject'));
      }
      return;
    }

    try {
      setIsAddingToNotes(true);
      // Long selections are distilled into a compact note by the small model;
      // short ones (and any generation failure) go in verbatim.
      const noteText = await summarizeSelectionForNotes(selectedTextMarkdown || selectedText, currentSessionId);
      const insight = normalizeDistilledInsight(noteText);
      if (!insight) {
        toast.error(t('chat.textSelection.toast.addToNotesFailed'));
        return;
      }
      // Recorded as its own note with provenance, so the distilled insight can
      // later be traced back to the conversation it came from.
      const saved = await useProjectContextStore.getState().createNote(currentProjectRef, {
        body: insight,
        source: 'selection',
        ...(currentSessionId ? { origin: { sessionId: currentSessionId } } : {}),
      });
      if (!saved) {
        toast.error(t('chat.textSelection.toast.addToNotesFailed'));
        return;
      }
      toast.success(t('chat.textSelection.toast.addToNotesSuccess'));
      hideMenu();
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      const description = error instanceof Error ? error.message : undefined;
      toast.error(t('chat.textSelection.toast.addToNotesFailed'), description ? { description } : undefined);
    } finally {
      setIsAddingToNotes(false);
    }
  }, [currentProjectRef, currentSessionId, hideMenu, selectedText, selectedTextMarkdown, t]);

  if (!position.show) return null;

  const commentHighlightOverlay = commentMode && commentRects && commentRects.length > 0
    ? createPortal(
      <div className="pointer-events-none fixed inset-0 z-[5]">
        {commentRects.map((rect, index) => (
          <div
            key={index}
            className="oc-chat-comment-rect absolute"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        ))}
      </div>,
      document.body,
    )
    : null;

  const commentInput = (
    <div
      className={cn(
        'oc-glass-popover flex items-end gap-2 rounded-3xl border border-[var(--interactive-border)]',
        'pl-4 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
        'py-1 pr-1',
        'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
        isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
      )}
    >
      <textarea
        ref={commentInputRef}
        rows={1}
        value={commentText}
        onChange={(event) => {
          setCommentText(event.target.value);
          resizeCommentInput();
        }}
        onKeyDown={(event) => {
          // An IME candidate is confirmed with Enter and abandoned with
          // Escape; neither keystroke belongs to the comment yet.
          if (isIMECompositionEvent(event)) return;
          // Desktop: Enter attaches, Shift+Enter breaks the line. (Mobile has
          // no floating input anymore; its comment editor keeps Enter as a
          // line break and attaches through the button.)
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleAttachComment();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            hideMenu();
          }
        }}
        placeholder={t('chat.textSelection.comment.placeholder')}
        className={cn(
          'flex-1 resize-none bg-transparent text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground placeholder:opacity-60',
          'w-64 max-w-[70vw] py-1.5'
        )}
        style={{ minHeight: 0, height: 'auto' }}
      />
      <button
        type="button"
        onClick={handleAttachComment}
        className={cn(
          'mb-0.5 flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity duration-150',
          'h-8 w-8'
        )}
        aria-label={t('chat.textSelection.comment.attach')}
        title={t('chat.textSelection.comment.attach')}
      >
        <Icon name="attachment-2" className="h-4 w-4" />
      </button>
    </div>
  );

  // Mobile: while the composer's comment mode is active, only the quoted
  // range's highlight overlay stays; the action sheet is gone and the comment
  // UI lives in the composer. Otherwise the action sheet only — commenting
  // hands off to the column's composer (see handleOpenMobileComment); no
  // floating comment input, no overlay positioning on this path.
  if (isMobile) {
    if (commentMode) {
      return commentHighlightOverlay;
    }
    return createPortal(
      <div
        ref={menuRef}
        className={cn(
          'fixed left-3 right-3 bottom-0 z-50 mx-auto max-w-[420px]',
          'oc-glass-popover rounded-2xl border border-[var(--interactive-border)]',
          'p-2 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
          'safe-area-bottom',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
        )}
        style={{
          bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleOpenMobileComment}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left',
              'text-sm font-medium leading-tight',
              'bg-[var(--surface-muted)] text-[var(--surface-foreground)]',
              'active:opacity-80',
              'transition-opacity duration-150'
            )}
            title={t('chat.textSelection.title.commentOnSelection')}
            type="button"
          >
            <Icon name="chat-1" className="h-5 w-5 flex-shrink-0" />
            <span className="min-w-0 whitespace-normal">{t('chat.textSelection.actions.comment')}</span>
          </button>

          <button
            onClick={handleAddToChat}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left',
              'text-sm font-medium leading-tight',
              'bg-[var(--primary-base)] text-[var(--primary-foreground)]',
              'active:opacity-80',
              'transition-opacity duration-150'
            )}
            title={t('chat.textSelection.title.addToCurrentChat')}
            type="button"
          >
            <Icon name="add" className="h-5 w-5 flex-shrink-0" />
            <span className="min-w-0 whitespace-normal">{t('chat.textSelection.actions.addToInput')}</span>
          </button>

          {currentSessionId ? (
            <button
              onClick={handleAskOpenChamber}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left',
                'text-sm font-medium leading-tight',
                'bg-[var(--surface-muted)] text-[var(--surface-foreground)]',
                'active:opacity-80',
                'transition-opacity duration-150'
              )}
              title={t('chat.textSelection.title.askOpenChamber')}
              type="button"
            >
              <Icon name="chat-ai-3" className="h-5 w-5 flex-shrink-0" />
              <span className="min-w-0 whitespace-normal">{t('chat.textSelection.actions.askOpenChamber')}</span>
            </button>
          ) : null}

          {!isVSCodeRuntime() ? (
            <button
              onClick={handleAddToNotes}
              disabled={isAddingToNotes}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left',
                'text-sm font-medium leading-tight',
                'bg-[var(--surface-muted)] text-[var(--surface-foreground)]',
                'active:opacity-80 disabled:opacity-60 disabled:cursor-not-allowed',
                'transition-opacity duration-150'
              )}
              title={t('chat.textSelection.title.saveInsightToNotes')}
              type="button"
            >
              {isAddingToNotes ? <Icon name="loader-4" className="h-5 w-5 flex-shrink-0 animate-spin" /> : <Icon name="booklet" className="h-5 w-5 flex-shrink-0" />}
              <span className="min-w-0 whitespace-normal">{t('chat.textSelection.actions.addToNotes')}</span>
            </button>
          ) : null}
        </div>
      </div>,
      document.body
    );
  }

  // Desktop: Show as a popup above the selection
  return createPortal(
    <div
      ref={menuRef}
      className="app-region-no-drag fixed z-50"
      style={{
        left: position.x,
        top: position.y,
        visibility: anchorVisible ? undefined : 'hidden',
        transform: position.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      {commentMode ? (<>{commentHighlightOverlay}{commentInput}</>) : (
        <div
          className={cn(
            'flex items-center whitespace-nowrap',
            'oc-glass-popover rounded-full border border-[var(--interactive-border)]',
            'shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
            'p-1',
            'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
            isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
          )}
        >
          <button
            onClick={handleOpenComment}
            className={cn(
              'px-3.5 py-1.5 rounded-full',
              'text-sm font-medium',
              'text-foreground',
              'hover:bg-[var(--interactive-hover)]',
              'transition-colors duration-150'
            )}
            title={t('chat.textSelection.title.commentOnSelection')}
            type="button"
          >
            {t('chat.textSelection.actions.comment')}
          </button>

          {currentSessionId ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />
              <button
                onClick={handleAskOpenChamber}
                className={cn(
                  'px-3.5 py-1.5 rounded-full',
                  'text-sm font-medium',
                  'text-foreground',
                  'hover:bg-[var(--interactive-hover)]',
                  'transition-colors duration-150'
                )}
                title={t('chat.textSelection.title.askOpenChamber')}
                type="button"
              >
                {t('chat.textSelection.actions.askOpenChamber')}
              </button>
            </>
          ) : null}


          {!isVSCodeRuntime() ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />

              <button
                onClick={handleAddToNotes}
                disabled={isAddingToNotes}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full',
                  'text-sm font-medium',
                  'text-foreground',
                  'hover:bg-[var(--interactive-hover)] disabled:opacity-60 disabled:cursor-not-allowed',
                  'transition-colors duration-150'
                )}
                title={t('chat.textSelection.title.saveInsightToNotes')}
                type="button"
              >
                {isAddingToNotes ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
                <span className="whitespace-nowrap">{t('chat.textSelection.actions.addToNotes')}</span>
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>,
    document.body
  );
};
