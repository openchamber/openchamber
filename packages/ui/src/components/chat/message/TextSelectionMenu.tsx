import React from 'react';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { createPortal, flushSync } from 'react-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChatColumnActions, useChatSessionSelection } from '../chatColumnSession';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionDirectory } from '@/sync/sync-context';
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
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { getTypeToCommentText } from '@/lib/typeToComment';
import { useCommentImagePaste } from '@/components/comments/useCommentImagePaste';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useLiveActivityHold } from '@/hooks/useLiveActivityHold';
import { useCommentQuoteRects } from '@/hooks/useCommentQuoteRects';
import { useSelectionCommentHandoff } from '@/hooks/useSelectionCommentHandoff';
import {
    useMobileCommentComposerController,
    useMobileCommentDraft,
} from '../composer/comment/MobileCommentComposerContext';
import { appendWithLineBreaks } from '../composer/text';
import { SelectionApprovalButton } from './SelectionApprovalButton';
import { SelectionCommentInput } from './SelectionCommentInput';
import { GUEST_ITEM_MESSAGE_TEXT_MAX } from '@openchamber/sdk';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { guestActionsWhere, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestAction } from '@/lib/guests/run-action';
import { rangeToMarkdown, trimSelectionValue, wrapMarkdownSelectionForChat } from './selectionMarkdown';
import { resolveShadowSelectionRange } from './shadowSelection';
import { registerActiveSelectionToolbar } from '@/lib/addSelectionToChat';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { frameRectInApp, onFrameSelection } from './frameSelection';
import { ownsSelection } from './selectionOwner';
import { captureChatQuoteAnchor, findChatQuoteRoots, findUiRenderQuoteRoot, resolveChatQuoteAnchor, type ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import {
  DESKTOP_MENU_FALLBACK_HEIGHT_PX,
  DESKTOP_MENU_FALLBACK_WIDTH_PX,
  getDesktopClampedX,
  getDesktopMenuY,
  type DesktopMenuPlacement,
} from './selectionMenuPosition';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
  readingKey: string;
  canReadAloud: boolean;
  uiRenderSelection?: boolean;
  frameSelections?: boolean;
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
  range?: Range;
  measureRect?: () => DOMRect;
  anchor?: ChatQuoteAnchor;
  clear?: () => void;
}

const normalizeDistilledInsight = (insight: string): string => (
  insight.trim().replace(/^[-*+]\s+/, '').slice(0, PROJECT_NOTE_BODY_MAX_LENGTH)
);

const TextSelectionMenuImpl: React.FC<TextSelectionMenuProps> = ({ containerRef, readingKey, canReadAloud, frameSelections = false, uiRenderSelection = false }) => {
  const guestActions = useGuestActions();
  const { t } = useI18n();
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, placement: 'above', show: false });
  const [anchorVisible, setAnchorVisible] = React.useState(true);
  const [selectedText, setSelectedText] = React.useState('');
  const [selectedTextMarkdown, setSelectedTextMarkdown] = React.useState('');
  const [selectedMessageId, setSelectedMessageId] = React.useState<string | null>(null);
  const { isPlaying: isReading, play: playReading, stop: stopReading } = useMessageTTS(uiRenderSelection ? selectedMessageId ?? readingKey : readingKey);
  const [selectedAnchor, setSelectedAnchor] = React.useState<ChatQuoteAnchor | null>(null);
  const [commentMode, setCommentMode] = React.useState(false);
  const commentModeRef = React.useRef(false);
  const foldPagesShown = useLiveActivityHold(position.show);
  const [commentText, setCommentText] = React.useState('');
  const pendingSelectionRef = React.useRef<SelectionPayload | null>(null);
  const { commentRects, setCommentRects, updateCommentRects } = useCommentQuoteRects(pendingSelectionRef, commentMode);

  const commentImagePaste = useCommentImagePaste();
  const { attachCitedImages, discardPastedImages, snapshotPastedImages, adoptPastedImages } = commentImagePaste;
  const isDraggingRef = React.useRef(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const [isAddingToNotes, setIsAddingToNotes] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuWidthRef = React.useRef(DESKTOP_MENU_FALLBACK_WIDTH_PX);
  const menuHeightRef = React.useRef(DESKTOP_MENU_FALLBACK_HEIGHT_PX);
  const anchorRectRef = React.useRef<DOMRect | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const mouseUpTimeoutRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);
  const activeAddToChatCleanupRef = React.useRef<(() => void) | null>(null);
  const currentSessionId = useChatSessionSelection().sessionId;
  const { focusInput: focusColumnInput, pinned: columnPinned } = useChatColumnActions();
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addContextDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
  const requestBtwComposer = useInputStore((state) => state.requestBtwComposer);
  const isMobile = useUIStore((state) => state.isMobile);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const effectiveDirectory = useEffectiveDirectory();
  const currentSessionDirectory = useSessionDirectory(currentSessionId);
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
    const ended = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    anchorRectRef.current = null;
    activeAddToChatCleanupRef.current?.();
    activeAddToChatCleanupRef.current = null;
    setCommentRects(null);
    ended?.clear?.();

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

  React.useEffect(() => hideMenu, [currentSessionId, newSessionDraftOpen, hideMenu]);

  const mobileCommentActiveRef = React.useRef(false);
  React.useEffect(() => {
    mobileCommentActiveRef.current = mobileCommentActive;
    if (!mobileCommentActive && isMobile && commentModeRef.current) {
      hideMenu();
    }
  }, [hideMenu, isMobile, mobileCommentActive]);

  const getDesktopPosition = React.useCallback((rect: DOMRect) => {
    const boundary = containerRef.current?.closest('[data-scrollbar="chat"], [data-selection-menu-boundary]');
    const { y, placement } = getDesktopMenuY({
      selectionTop: rect.top,
      selectionBottom: rect.bottom,
      menuHeight: menuHeightRef.current,
      viewportHeight: window.innerHeight,
      boundaryTop: boundary ? boundary.getBoundingClientRect().top : 0,
    });
    const centerX = getDesktopClampedX(rect.left + rect.width / 2, window.innerWidth, menuWidthRef.current);
    return {
      x: Math.round(centerX - menuWidthRef.current / 2),
      y: Math.round(placement === 'above' ? y - menuHeightRef.current : y),
      placement,
    };
  }, [containerRef]);

  React.useEffect(() => {
    const scope = containerRef.current;
    const partId = selectedAnchor?.page?.kind === 'ui' ? selectedAnchor.page.partId : null;
    if (!uiRenderSelection || !commentMode || !scope || !selectedMessageId || !partId || !selectedAnchor) return;
    const selector = `[data-ui-render-message="${CSS.escape(selectedMessageId)}"][data-ui-render-part="${CSS.escape(partId)}"]`;
    let frame: number | null = null;
    const restore = () => {
      frame = null;
      const page = findUiRenderQuoteRoot(scope, selectedMessageId, partId);
      const pending = pendingSelectionRef.current;
      if (!page || !pending || (pending.range && page.contains(pending.range.startContainer))) return;
      const range = resolveChatQuoteAnchor(page, selectedAnchor);
      if (!range) return;
      pending.range = range;
      const rect = range.getBoundingClientRect();
      anchorRectRef.current = rect;
      updateCommentRects();
      if (!isMobile) {
        const boundary = scope.closest('[data-scrollbar="chat"], [data-selection-menu-boundary]')?.getBoundingClientRect();
        setAnchorVisible(!boundary || (rect.bottom > boundary.top && rect.top < boundary.bottom));
        setPosition((previous) => ({ ...previous, ...getDesktopPosition(rect) }));
      }
    };
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return target?.closest(selector) || [...record.addedNodes].some((node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector)));
      });
      if (relevant && frame === null) frame = window.requestAnimationFrame(restore);
    });
    observer.observe(scope, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [commentMode, containerRef, getDesktopPosition, isMobile, selectedAnchor, selectedMessageId, uiRenderSelection, updateCommentRects]);

  const addMarkdownToChat = React.useCallback((markdownText: string) => {
    const markdownBlock = wrapMarkdownSelectionForChat(markdownText);
    setPendingInputText(markdownBlock, 'append', columnPinned ? currentSessionId : null);

    hideMenu();

    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      focusColumnInput();
    });
  }, [columnPinned, currentSessionId, focusColumnInput, hideMenu, setPendingInputText]);

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
  }, [commentMode, commentText, getDesktopPosition, isMobile, position.show]);

  const followAnchor = React.useCallback(() => {
    const pending = pendingSelectionRef.current;
    const rect = pending?.range?.getBoundingClientRect() ?? pending?.measureRect?.();
    if (!rect) return;
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
  }, [containerRef, getDesktopPosition]);

  React.useEffect(() => {
    if (!position.show || isMobile) {
      return;
    }
    let frame: number | null = null;
    const follow = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        followAnchor();
      });
    };
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('scroll', follow, { capture: true });
    };
  }, [followAnchor, isMobile, position.show]);

  const foldPagesShownRef = React.useRef(foldPagesShown);
  React.useLayoutEffect(() => {
    if (foldPagesShownRef.current === foldPagesShown) return;
    foldPagesShownRef.current = foldPagesShown;
    if (!position.show || isMobile) return;
    followAnchor();
    if (commentModeRef.current) updateCommentRects();
  }, [foldPagesShown, followAnchor, isMobile, position.show, updateCommentRects]);

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

    if (!text && pendingSelectionRef.current && !pendingSelectionRef.current.range) {
      return;
    }

    if (!text) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    const range = selection.getRangeAt(0);
    if (uiRenderSelection) {
      const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const page = element?.closest('[data-ui-render-hoisted]');
      if (!page || !page.contains(range.endContainer)) {
        if (!isDraggingRef.current) hideMenu();
        return;
      }
    }
    
    if (!ownsSelection(container, range)) {
      if (!isDraggingRef.current) {
        hideMenu();
      }
      return;
    }

    const measuredRange = resolveShadowSelectionRange(range, text) ?? range;
    const rect = measuredRange.getBoundingClientRect();

    const anchorElement = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    const replaced = pendingSelectionRef.current;
    pendingSelectionRef.current = {
      plainText: text,
      markdownText: rangeToMarkdown(range, text),
      rect,
      messageId: uiRenderSelection
        ? anchorElement?.closest('[data-ui-render-message]')?.getAttribute('data-ui-render-message') ?? null
        : anchorElement?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null,
      range: measuredRange.cloneRange(),
    };
    replaced?.clear?.();

    if (!isDraggingRef.current) {
      showMenu();
    }
  }, [containerRef, hideMenu, showMenu, uiRenderSelection]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseDown = (event: MouseEvent) => {
      // SAFETY: a MouseEvent target inside the document is always a Node;
      // `contains` only needs that.
      if (commentModeRef.current && menuRef.current?.contains(event.target as Node)) {
        return;
      }
      if (mobileCommentActiveRef.current) {
        return;
      }
      isDraggingRef.current = true;
      hideMenu();
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      if (pendingSelectionRef.current?.range) {
        if (mouseUpTimeoutRef.current !== null) {
          window.clearTimeout(mouseUpTimeoutRef.current);
        }
        mouseUpTimeoutRef.current = window.setTimeout(() => {
          mouseUpTimeoutRef.current = null;
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

    document.addEventListener('selectionchange', handleSelectionChange);
    
    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);

    const handleClickOutside = (e: MouseEvent) => {
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

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !frameSelections) return;
    return onFrameSelection(container, (selection, frame) => {
      const text = trimSelectionValue(selection.text);
      const isFrameSelection = Boolean(pendingSelectionRef.current && !pendingSelectionRef.current.range);
      if (!text && selection.dismiss) {
        if (isFrameSelection) hideMenu();
        return;
      }
      if (commentModeRef.current || mobileCommentActiveRef.current) return;
      if (!text) {
        if (isFrameSelection) hideMenu();
        return;
      }
      const measureRect = () => frameRectInApp(frame, selection.rect);
      pendingSelectionRef.current = {
        plainText: text,
        markdownText: text,
        rect: measureRect(),
        measureRect,
        messageId: readingKey,
        anchor: selection.anchor,
        clear: selection.clear,
      };
      showMenu();
    });
  }, [containerRef, frameSelections, hideMenu, readingKey, showMenu]);

  const handleAddToChat = React.useCallback(() => {
    if (!selectedTextMarkdown) return;
    addMarkdownToChat(selectedTextMarkdown);
  }, [addMarkdownToChat, selectedTextMarkdown]);

  const handleAskOpenChamber = React.useCallback(() => {
    if (!currentSessionId || !selectedTextMarkdown) return;
    requestBtwComposer({
      parentSessionId: currentSessionId,
      text: appendWithLineBreaks('', wrapMarkdownSelectionForChat(selectedTextMarkdown)),
    });
    hideMenu();
    window.getSelection()?.removeAllRanges();
    queueMicrotask(() => {
      focusColumnInput();
    });
  }, [currentSessionId, focusColumnInput, hideMenu, requestBtwComposer, selectedTextMarkdown]);

  const handleReadAloud = React.useCallback(() => {
    if (isReading) {
      stopReading();
      return;
    }
    if (!selectedText) return;
    void playReading(selectedText, { summarize: false });
    hideMenu();
    window.getSelection()?.removeAllRanges();
  }, [hideMenu, isReading, playReading, selectedText, stopReading]);

  const readAloudLabel = isReading ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud');

  const captureCommentAnchor = React.useCallback((): ChatQuoteAnchor | null => {
    const container = containerRef.current;
    const pending = pendingSelectionRef.current;
    if (pending && !pending.range) return pending.anchor ?? null;
    if (!container || !pending?.range) return null;
    if (uiRenderSelection) {
      const element = pending.range.startContainer instanceof Element ? pending.range.startContainer : pending.range.startContainer.parentElement;
      const page = element?.closest('[data-ui-render-part]');
      const partId = page?.getAttribute('data-ui-render-part');
      if (!page || !partId) return null;
      const anchor = captureChatQuoteAnchor(page, pending.range);
      return anchor ? { ...anchor, page: { partId, kind: 'ui' } } : null;
    }
    const scope = container.closest('[data-scrollbar="chat"]');
    const roots = scope && pending.messageId ? findChatQuoteRoots(scope, pending.messageId) : [];
    return captureChatQuoteAnchor(roots.includes(container) ? roots : [container], pending.range);
  }, [containerRef, uiRenderSelection]);

  const openComment = React.useCallback((initialText: string) => {
    if (!selectedTextMarkdown) return;
    discardPastedImages();
    setSelectedAnchor(captureCommentAnchor());
    setCommentText(initialText);
    setCommentMode(true);
    commentModeRef.current = true;
    updateCommentRects();
    window.getSelection()?.removeAllRanges();
  }, [captureCommentAnchor, discardPastedImages, selectedTextMarkdown, updateCommentRects]);

  const handleOpenComment = React.useCallback(() => openComment(''), [openComment]);

  useSelectionCommentHandoff({
    handoffKey: currentSessionId && !uiRenderSelection && !frameSelections && !isMobile ? `${currentSessionId}:${readingKey}` : null,
    containerRef,
    messageId: readingKey,
    readDraft: () => (commentMode && selectedAnchor ? {
      plainText: selectedText, markdownText: selectedTextMarkdown, messageId: selectedMessageId,
      anchor: selectedAnchor, commentText, pastedImages: snapshotPastedImages(),
    } : null),
    restore: (draft, range) => {
      pendingSelectionRef.current = { plainText: draft.plainText, markdownText: draft.markdownText, messageId: draft.messageId, rect: range.getBoundingClientRect(), range };
      showMenu();
      adoptPastedImages(draft.pastedImages);
      setSelectedAnchor(draft.anchor);
      setCommentText(draft.commentText);
      setCommentMode(true);
      commentModeRef.current = true;
      updateCommentRects();
    },
  });

  React.useEffect(() => {
    if (!position.show || !anchorVisible || commentMode || isMobile) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const text = getTypeToCommentText(event);
      if (!text) return;
      event.preventDefault();
      openComment(text);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [anchorVisible, commentMode, isMobile, openComment, position.show]);

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
    setSelectedAnchor(quote.anchor);
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
    const composerTarget = mobileCommentController?.getScope() ?? null;
    if (!selectedTextMarkdown || !composerTarget) {
      hideMenu();
      return;
    }
    const draftId = addContextDraft(
      { directory: composerTarget.directory, sessionKey: composerTarget.sessionKey },
      {
        source: 'chat-quote',
        fileLabel: selectedMessageId ?? '',
        startLine: 1,
        endLine: 1,
        code: selectedTextMarkdown,
        language: '',
        text: commentText.trim(),
        anchor: selectedAnchor ?? undefined,
      },
    );
    if (!draftId) {
      toast.error(t('inlineComment.toast.noRoom'));
      return;
    }
    hideMenu();
    queueMicrotask(() => {
      focusColumnInput();
      void attachCitedImages(commentText, createChatDraftIdentity(
        composerTarget.runtimeKey, composerTarget.directory, composerTarget.sessionKey,
      ));
    });
  }, [addContextDraft, attachCitedImages, commentText, focusColumnInput, hideMenu, mobileCommentController, selectedAnchor, selectedMessageId, selectedTextMarkdown, t]);

  const getApprovalSelection = React.useCallback(() => {
    if (!pendingSelectionRef.current || !selectedTextMarkdown) return null;
    return { markdownText: selectedTextMarkdown, messageId: selectedMessageId, anchor: captureCommentAnchor() };
  }, [captureCommentAnchor, selectedMessageId, selectedTextMarkdown]);

  const finishApproval = React.useCallback(() => {
    hideMenu();
    window.getSelection()?.removeAllRanges();
  }, [hideMenu]);

  const selectionDirectory = effectiveDirectory ?? currentSessionDirectory ?? '';
  const spaceProjectDirectory = useSpaceProjectDirectory(selectionDirectory);
  const currentProjectRef = React.useMemo(() => {
    const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, selectionDirectory, spaceProjectDirectory);
    return resolved ? { id: resolved.id, path: resolved.path } : null;
  }, [availableWorktreesByProject, projects, selectionDirectory, spaceProjectDirectory]);

  const handleAddToNotes = React.useCallback(async () => {
    if (!selectedText || !currentProjectRef) {
      if (!currentProjectRef) {
        toast.error(t('chat.textSelection.toast.noProject'));
      }
      return;
    }

    try {
      setIsAddingToNotes(true);
      const noteText = await summarizeSelectionForNotes(selectedTextMarkdown || selectedText, currentSessionId);
      const insight = normalizeDistilledInsight(noteText);
      if (!insight) {
        toast.error(t('chat.textSelection.toast.addToNotesFailed'));
        return;
      }
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

  const selectionActions = currentSessionId && selectedMessageId ? guestActionsWhere(guestActions, 'selection') : [];
  const runSelectionAction = (entry: GuestActionEntry) => {
    if (!currentSessionId || !selectedMessageId) return;
    void runGuestAction(entry, {
      kind: 'selection',
      action: entry.action.id,
      sessionId: currentSessionId,
      directory: selectionDirectory || null,
      messageId: selectedMessageId,
      text: selectedTextMarkdown.slice(0, GUEST_ITEM_MESSAGE_TEXT_MAX),
    }, t);
    hideMenu();
  };

  const approvalButton = currentSessionId && selectedMessageId
    ? <SelectionApprovalButton mobile={isMobile} getSelection={getApprovalSelection} onSuccess={finishApproval} />
    : null;

  const commentInput = (
    <SelectionCommentInput
      value={commentText}
      onChange={setCommentText}
      onSubmit={handleAttachComment}
      onCancel={hideMenu}
      imagePaste={commentImagePaste}
      opening={isOpening}
    />
  );

  if (isMobile) {
    if (commentMode) {
      return commentHighlightOverlay;
    }
    return createPortal(
      <div
        ref={menuRef}
        className={cn(
          'fixed inset-s-3 inset-e-3 bottom-0 z-50 mx-auto max-w-[420px]',
          'oc-glass-popover oc-glass-floating rounded-2xl',
          'p-2',
          'safe-area-bottom',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
        )}
        style={{
          bottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="flex flex-col gap-2">
          <div className={cn('gap-2', canReadAloud ? 'flex' : 'grid grid-cols-2')}>
            <button
              onClick={handleOpenMobileComment}
              className={cn(
                'flex flex-auto items-center gap-2 rounded-xl px-3 py-2.5 text-start',
                'text-sm font-medium leading-tight',
                'bg-foreground/[0.04] text-foreground',
                'active:opacity-80',
                'transition-opacity duration-150'
              )}
              title={t('chat.textSelection.title.commentOnSelection')}
              type="button"
            >
              <Icon name="chat-1" className="h-5 w-5 flex-shrink-0" />
              <span className="whitespace-normal hyphens-auto">{t('chat.textSelection.actions.comment')}</span>
            </button>

            <Tooltip>
            <TooltipTrigger asChild>
            <button
              onClick={handleAddToChat}
              className={cn(
                'flex flex-[1_0_auto] items-center gap-2 rounded-xl px-3 py-2.5 text-start',
                'text-sm font-medium leading-tight',
                'bg-[var(--primary-base)] text-[var(--primary-foreground)]',
                'active:opacity-80',
                'transition-opacity duration-150'
              )}
              aria-label={t('chat.textSelection.title.addToCurrentChat')}
              type="button"
            >
              <Icon name="add" className="h-5 w-5 flex-shrink-0" />
              <span className="whitespace-normal hyphens-auto">{t('chat.textSelection.actions.addToInput')}</span>
            </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}><TooltipLabelWithShortcut label={t('chat.textSelection.title.addToCurrentChat')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('add_selection_to_chat', shortcutOverrides), '')} /></TooltipContent>
            </Tooltip>

            {canReadAloud ? (
              <button
                onClick={handleReadAloud}
                className={cn(
                  'flex flex-[1_0_auto] items-center gap-2 rounded-xl px-3 py-2.5 text-start',
                  'text-sm font-medium leading-tight',
                  'bg-foreground/[0.04] text-foreground',
                  'active:opacity-80',
                  'transition-opacity duration-150'
                )}
                title={readAloudLabel}
                type="button"
              >
                <Icon name="volume-up" className={cn('h-5 w-5 flex-shrink-0', isReading && 'text-[var(--primary-text)]')} />
                <span className="whitespace-normal hyphens-auto">
                  {isReading ? t('chat.textSelection.actions.stopReading') : t('chat.textSelection.actions.read')}
                </span>
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2 [&>button]:flex-[1_1_40%]">
            {currentSessionId ? (
              <button
                onClick={handleAskOpenChamber}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-start',
                  'text-sm font-medium leading-tight',
                  'bg-foreground/[0.04] text-foreground',
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
                  'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-start',
                  'text-sm font-medium leading-tight',
                  'bg-foreground/[0.04] text-foreground',
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

            {selectionActions.map((entry) => (
              <button
                key={`${entry.guest.id}:${entry.action.id}`}
                onClick={() => runSelectionAction(entry)}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-start',
                  'text-sm font-medium leading-tight',
                  'bg-foreground/[0.04] text-foreground',
                  'active:opacity-80',
                  'transition-opacity duration-150'
                )}
                type="button"
              >
                <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="h-5 w-5 flex-shrink-0" />
                <span className="min-w-0 whitespace-normal">{entry.action.label}</span>
              </button>
            ))}

            {approvalButton}
          </div>
        </div>
      </div>,
      document.body
    );
  }

  const menuPortalTarget = (frameSelections
    ? containerRef.current?.closest<HTMLElement>('[data-slot="dialog-content"]')
    : null) ?? document.body;
  return createPortal(
    <div
      ref={menuRef}
      className="app-region-no-drag fixed z-50"
      style={{
        left: position.x,
        top: position.y,
        visibility: anchorVisible ? undefined : 'hidden',
      }}
    >
      {commentMode ? (<>{commentHighlightOverlay}{commentInput}</>) : (
        <div
          className={cn(
            'flex items-center whitespace-nowrap',
            'oc-glass-popover oc-glass-floating rounded-full',
            'p-1',
            'transition-[opacity,transform] duration-200 ease-out',
            isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
          )}
        >
          <HoverTooltip label={t('chat.textSelection.title.commentOnSelection')}>
            <button
              onClick={handleOpenComment}
              className={cn(
                'px-3.5 py-1.5 rounded-full',
                'text-sm font-medium',
                'text-foreground',
                'hover:bg-[var(--interactive-hover)]',
                'transition-colors duration-150'
              )}
              type="button"
            >
              {t('chat.textSelection.actions.comment')}
            </button>
          </HoverTooltip>

          {currentSessionId ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />
              <HoverTooltip label={t('chat.textSelection.title.askOpenChamber')}>
                <button
                  onClick={handleAskOpenChamber}
                  className={cn(
                    'px-3.5 py-1.5 rounded-full',
                    'text-sm font-medium',
                    'text-foreground',
                    'hover:bg-[var(--interactive-hover)]',
                    'transition-colors duration-150'
                  )}
                  type="button"
                >
                  {t('chat.textSelection.actions.askOpenChamber')}
                </button>
              </HoverTooltip>
            </>
          ) : null}


          {!isVSCodeRuntime() ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />

              <HoverTooltip label={t('chat.textSelection.title.saveInsightToNotes')}>
                <span className="inline-flex">
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
                    type="button"
                  >
                    {isAddingToNotes ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
                    <span className="whitespace-nowrap">{t('chat.textSelection.actions.addToNotes')}</span>
                  </button>
                </span>
              </HoverTooltip>
            </>
          ) : null}

          {selectionActions.length > 0 ? <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" /> : null}
          {selectionActions.map((entry) => (
            <HoverTooltip key={`${entry.guest.id}:${entry.action.id}`} label={entry.action.label}>
              <button
                onClick={() => runSelectionAction(entry)}
                aria-label={entry.action.label}
                className={cn(
                  'flex items-center rounded-full',
                  entry.action.display === 'icon' ? 'h-8 w-8 justify-center' : 'gap-1.5 px-3.5 py-1.5',
                  'text-sm font-medium',
                  'text-foreground',
                  'hover:bg-[var(--interactive-hover)]',
                  'transition-colors duration-150'
                )}
                type="button"
              >
                {entry.action.display === 'icon' || entry.action.display === 'both'
                  ? <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="h-4 w-4" />
                  : null}
                {entry.action.display === 'icon' ? null : <span className="whitespace-nowrap">{entry.action.label}</span>}
              </button>
            </HoverTooltip>
          ))}

          {approvalButton ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />
              {approvalButton}
            </>
          ) : null}

          {canReadAloud ? (
            <>
              <div className="mx-0.5 h-5 w-px shrink-0 bg-[var(--interactive-border)]" />
              <HoverTooltip label={readAloudLabel}>
                <button
                  onClick={handleReadAloud}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full',
                    isReading ? 'text-[var(--primary-text)]' : 'text-foreground',
                    'hover:bg-[var(--interactive-hover)]',
                    'transition-colors duration-150'
                  )}
                  aria-label={readAloudLabel}
                  type="button"
                >
                  <Icon name="volume-up" className={cn('h-4 w-4', isReading && 'text-[var(--primary-text)]')} />
                </button>
              </HoverTooltip>
            </>
          ) : null}
        </div>
      )}
    </div>,
    menuPortalTarget
  );
};

export const TextSelectionMenu = React.memo(TextSelectionMenuImpl);
