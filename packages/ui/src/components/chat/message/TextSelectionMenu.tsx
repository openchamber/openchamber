import React from 'react';
import { createPortal } from 'react-dom';
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
import { rangeToMarkdown, trimSelectionValue, wrapMarkdownSelectionForChat } from './selectionMarkdown';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { registerActiveSelectionToolbar } from '@/lib/addSelectionToChat';
import { collectSelectionOverlayRects } from '@/lib/selectionOverlayRects';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
}

interface MenuPosition {
  x: number;
  y: number;
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

const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;
export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef }) => {
  const { t } = useI18n();
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, show: false });
  const [selectedText, setSelectedText] = React.useState('');
  const [selectedTextMarkdown, setSelectedTextMarkdown] = React.useState('');
  const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(null);
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
  const pendingSelectionRef = React.useRef<SelectionPayload | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const mouseUpTimeoutRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);
  const activeAddToChatCleanupRef = React.useRef<(() => void) | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addContextDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
  const isMobile = useUIStore((state) => state.isMobile);
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const effectiveDirectory = useEffectiveDirectory();
  const sessions = useSessions();

  // Mobile: the comment bar is rendered inside the composer form (its
  // positioning context), so it inherits the runtime's own keyboard handling
  // — browser viewport resizing and Capacitor choreography alike. This effect
  // only centers it on the composer pill in the form's local coordinates; no
  // viewport math, which Safari's keyboard handling reliably breaks for
  // fixed elements.
  React.useEffect(() => {
    if (!commentMode || !isMobile) return;
    const update = () => {
      const element = menuRef.current;
      const host = element?.offsetParent;
      if (!element || !host) return;
      const pill = document.querySelector('[data-mobile-composer-pill="true"]')
        ?? document.querySelector('[data-chat-input="true"]');
      const pillRect = pill?.getBoundingClientRect();
      if (!pillRect || pillRect.height <= 0) return;
      const hostRect = host.getBoundingClientRect();
      element.style.top = `${pillRect.top - hostRect.top + (pillRect.height - element.offsetHeight) / 2}px`;
      element.style.left = `${pillRect.left - hostRect.left}px`;
      element.style.width = `${pillRect.width}px`;
      element.style.bottom = 'auto';
    };
    update();
    const raf = window.requestAnimationFrame(update);
    // The composer relayouts with its own transitions and timeouts that emit
    // no event; a light poll keeps the overlay glued to the pill.
    const poll = window.setInterval(update, 200);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearInterval(poll);
    };
  }, [commentMode, isMobile]);

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
    setSelectedText('');
    setSelectedTextMarkdown('');
    setSelectedMessageId(null);
    setCommentMode(false);
    commentModeRef.current = false;
    setCommentText('');
    isMenuVisibleRef.current = false;
  }, []);

  const getDesktopClampedX = React.useCallback((anchorX: number) => {
    if (typeof window === 'undefined') {
      return anchorX;
    }

    const viewportWidth = window.innerWidth;
    const menuWidth = menuWidthRef.current;
    const halfWidth = menuWidth / 2;
    const minX = DESKTOP_MENU_SIDE_MARGIN_PX + halfWidth;
    const maxX = viewportWidth - DESKTOP_MENU_SIDE_MARGIN_PX - halfWidth;

    if (minX > maxX) {
      return viewportWidth / 2;
    }

    return Math.min(Math.max(anchorX, minX), maxX);
  }, []);

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

    // Position menu above the selection
    const menuX = isMobile
      ? rect.left + rect.width / 2
      : getDesktopClampedX(rect.left + rect.width / 2);
    const menuY = rect.top - 10;

    setSelectedText(plainText);
    setSelectedTextMarkdown(markdownText);
    setSelectedMessageId(messageId);
    setPosition({
      x: menuX,
      y: menuY,
      show: true,
    });
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
  }, [addMarkdownToChat, getDesktopClampedX, hideMenu, isMobile, position.show]);

  React.useLayoutEffect(() => {
    if (!position.show || isMobile || !menuRef.current) {
      return;
    }

    const measuredWidth = menuRef.current.offsetWidth;
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 || measuredWidth === menuWidthRef.current) {
      return;
    }

    menuWidthRef.current = measuredWidth;
    setPosition((prev) => ({
      ...prev,
      x: getDesktopClampedX(prev.x),
    }));
  }, [getDesktopClampedX, isMobile, position.show]);

  // The desktop popup hangs above its anchor, so a tall comment box near the
  // top of the chat can climb over the app header. On the desktop shell the
  // header is a window drag zone, which makes the overlapped part of the
  // textarea untouchable, so the popup is pushed down until its top edge stays
  // inside the chat container.
  React.useLayoutEffect(() => {
    if (!position.show || isMobile || !menuRef.current) {
      return;
    }

    const container = containerRef.current;
    const minTop = (container ? container.getBoundingClientRect().top : 0) + 4;
    const menuTop = menuRef.current.getBoundingClientRect().top;
    if (menuTop < minTop) {
      const delta = minTop - menuTop;
      setPosition((prev) => ({ ...prev, y: prev.y + delta }));
    }
  }, [containerRef, isMobile, position.show, position.y, commentMode, commentText]);

  React.useEffect(() => {
    if (!position.show || isMobile) {
      return;
    }

    const handleViewportResize = () => {
      setPosition((prev) => ({
        ...prev,
        x: getDesktopClampedX(prev.x),
      }));
    };

    window.addEventListener('resize', handleViewportResize);
    return () => {
      window.removeEventListener('resize', handleViewportResize);
    };
  }, [getDesktopClampedX, isMobile, position.show]);

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

  const handleOpenComment = React.useCallback(() => {
    if (!selectedTextMarkdown) return;
    setCommentMode(true);
    commentModeRef.current = true;
    updateCommentRects();
    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      commentInputRef.current?.focus();
    });
  }, [selectedTextMarkdown, updateCommentRects]);

  const handleAttachComment = React.useCallback(() => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!selectedTextMarkdown || !sessionKey || !effectiveDirectory) {
      hideMenu();
      return;
    }
    addContextDraft({ directory: effectiveDirectory, sessionKey }, {
      source: 'chat-quote',
      fileLabel: selectedMessageId ?? '',
      startLine: 1,
      endLine: 1,
      code: selectedTextMarkdown,
      language: '',
      text: commentText.trim(),
    });
    hideMenu();
    queueMicrotask(() => {
      focusChatInput();
    });
  }, [addContextDraft, commentText, currentSessionId, effectiveDirectory, hideMenu, newSessionDraftOpen, selectedMessageId, selectedTextMarkdown]);

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
          // Desktop: Enter attaches, Shift+Enter breaks the line. Mobile
          // keyboards use Enter for line breaks; attaching is the button's job.
          if (event.key === 'Enter' && !event.shiftKey && !isMobile) {
            event.preventDefault();
            handleAttachComment();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            hideMenu();
          }
        }}
        placeholder={t('chat.textSelection.comment.placeholder')}
        className={cn(
          'flex-1 resize-none bg-transparent text-sm leading-5 text-[var(--surface-foreground)] outline-none placeholder:text-[var(--surface-mutedForeground)] placeholder:opacity-60',
          // The width cap sizes the floating desktop pill; on mobile the pill
          // spans the bottom bar and the cap would strand slack space to the
          // right of the attach button.
          isMobile ? 'w-full min-w-0 py-1.5 text-base leading-6' : 'w-64 max-w-[70vw] py-1.5'
        )}
        style={{ minHeight: 0, height: 'auto' }}
      />
      <button
        type="button"
        onClick={handleAttachComment}
        className={cn(
          'mb-0.5 flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity duration-150',
          isMobile ? 'h-9 w-9' : 'h-8 w-8'
        )}
        aria-label={t('chat.textSelection.comment.attach')}
        title={t('chat.textSelection.comment.attach')}
      >
        <Icon name="attachment-2" className="h-4 w-4" />
      </button>
    </div>
  );

  // Mobile: Show as a bar at the bottom of the screen, above the keyboard
  if (isMobile) {
    if (commentMode) {
      // Overlay the comment input onto the composer pill: rendering into the
      // composer form (position: relative) inherits the runtime's keyboard
      // handling in both browser and Capacitor; the centering effect above
      // glues it to the pill in the form's local coordinates.
      const composerHost = document.querySelector('form.oc-mobile-composer');
      const bar = (
        <div
          ref={menuRef}
          className={cn(
            'z-50',
            composerHost
              ? 'absolute inset-x-0 bottom-[var(--oc-safe-area-bottom-visual,0.5rem)]'
              : 'oc-chat-comment-bar fixed left-3 right-3 mx-auto max-w-[420px]',
          )}
        >
          {commentInput}
        </div>
      );
      return (
        <>
          {commentHighlightOverlay}
          {createPortal(bar, composerHost ?? document.body)}
        </>
      );
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
            onClick={handleOpenComment}
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
        transform: 'translate(-50%, -100%)',
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
              'text-[var(--surface-foreground)]',
              'hover:bg-[var(--interactive-hover)]',
              'transition-colors duration-150'
            )}
            title={t('chat.textSelection.title.commentOnSelection')}
            type="button"
          >
            {t('chat.textSelection.actions.comment')}
          </button>


          {!isVSCodeRuntime() ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />

              <button
                onClick={handleAddToNotes}
                disabled={isAddingToNotes}
                className={cn(
                  'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full',
                  'text-sm font-medium',
                  'text-[var(--surface-foreground)]',
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
