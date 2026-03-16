import React from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { RiChatNewLine, RiAddLine, RiFileCopyLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
}

interface MenuPosition {
  x: number;
  y: number;
  show: boolean;
}

const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef }) => {
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, show: false });
  const [selectedText, setSelectedText] = React.useState('');
  const [isDragging, setIsDragging] = React.useState(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuWidthRef = React.useRef(DESKTOP_MENU_FALLBACK_WIDTH_PX);
  const pendingSelectionRef = React.useRef<{ text: string; rect: DOMRect } | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);
  const createSession = useSessionStore((state) => state.createSession);
  const setPendingInputText = useSessionStore((state) => state.setPendingInputText);
  const isMobile = useUIStore((state) => state.isMobile);

  React.useEffect(() => {
    isMenuVisibleRef.current = position.show;
  }, [position.show]);

  React.useEffect(() => {
    return () => {
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
    };
  }, []);

  const hideMenu = React.useCallback(() => {
    pendingSelectionRef.current = null;

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

  const showMenu = React.useCallback(() => {
    if (!pendingSelectionRef.current) return;

    const { text, rect } = pendingSelectionRef.current;
    const shouldAnimateIn = !position.show;

    // Position menu above the selection
    const menuX = isMobile
      ? rect.left + rect.width / 2
      : getDesktopClampedX(rect.left + rect.width / 2);
    const menuY = rect.top - 10;

    setSelectedText(text);
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
  }, [getDesktopClampedX, isMobile, position.show]);

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
    const selection = window.getSelection();
    const container = containerRef.current;

    if (!selection || !container) {
      if (!isDragging) {
        hideMenu();
      }
      return;
    }

    const text = selection.toString().trim();

    // Only show if we have text and the selection is within our container
    if (!text) {
      if (!isDragging) {
        hideMenu();
      }
      return;
    }

    // Check if selection is within the container
    const range = selection.getRangeAt(0);
    
    if (!container.contains(range.commonAncestorContainer)) {
      if (!isDragging) {
        hideMenu();
      }
      return;
    }

    // Get selection coordinates
    const rect = range.getBoundingClientRect();

    // Store the selection but don't show menu yet if dragging
    pendingSelectionRef.current = { text, rect };

    // Only show menu if we're not currently dragging
    if (!isDragging) {
      showMenu();
    }
  }, [containerRef, hideMenu, showMenu, isDragging]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Track when dragging starts
    const handleMouseDown = () => {
      setIsDragging(true);
      hideMenu();
    };

    // Track when dragging stops
    const handleMouseUp = () => {
      setIsDragging(false);
      // Check if we have a pending selection to show
      if (pendingSelectionRef.current) {
        // Small delay to ensure selection is finalized
        setTimeout(() => {
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
        !window.getSelection()?.toString().trim()
      ) {
        hideMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [containerRef, handleSelectionChange, hideMenu, showMenu]);

  const handleAddToChat = React.useCallback(() => {
    if (!selectedText) return;

    const fenced = `\`\`\`md\n${selectedText}\n\`\`\``;
    setPendingInputText(fenced, 'append');
    
    hideMenu();
    
    // Clear selection
    window.getSelection()?.removeAllRanges();
  }, [selectedText, setPendingInputText, hideMenu]);

  const handleCreateNewSession = React.useCallback(async () => {
    if (!selectedText) return;

    const session = await createSession(undefined, null, null);
    if (session) {
      setPendingInputText(selectedText, 'replace');
    }

    hideMenu();
    window.getSelection()?.removeAllRanges();
  }, [selectedText, createSession, setPendingInputText, hideMenu]);

  const handleCopy = React.useCallback(async () => {
    if (!selectedText) return;

    const result = await copyTextToClipboard(selectedText);
    if (!result.ok) {
      console.error('Failed to copy:', result.error);
    }

    hideMenu();
    window.getSelection()?.removeAllRanges();
  }, [selectedText, hideMenu]);

  if (!position.show) return null;

  // Mobile: Show as a bar at the bottom of the screen, above the keyboard
  if (isMobile) {
    return createPortal(
      <div
        ref={menuRef}
        className={cn(
          'fixed left-0 right-0 bottom-0 z-50',
          'flex items-center justify-center gap-4',
          'bg-[var(--surface-elevated)] border-t border-[var(--interactive-border)]',
          'px-3 py-2',
          'safe-area-bottom',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
        )}
        style={{
          paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <button
          onClick={handleAddToChat}
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm font-medium',
            'bg-[var(--primary-base)] text-[var(--primary-foreground)]',
            'active:opacity-80',
            'transition-opacity duration-150'
          )}
          type="button"
        >
          <RiAddLine className="h-5 w-5" />
          <span>Add to chat</span>
        </button>
        
        <button
          onClick={handleCreateNewSession}
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm font-medium',
            'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
            'active:opacity-80',
            'transition-opacity duration-150'
          )}
          type="button"
        >
          <RiChatNewLine className="h-5 w-5" />
          <span>New session</span>
        </button>
        
        <button
          onClick={handleCopy}
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm font-medium',
            'bg-[var(--surface-muted)] text-[var(--surface-foreground)]',
            'active:opacity-80',
            'transition-opacity duration-150'
          )}
          type="button"
        >
          <RiFileCopyLine className="h-5 w-5" />
          <span>Copy</span>
        </button>
      </div>,
      document.body
    );
  }

  // Desktop: Show as a popup above the selection
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div
        className={cn(
          'flex items-center gap-1 whitespace-nowrap',
          'rounded-lg border border-[var(--interactive-border)]',
          'bg-[var(--surface-elevated)] shadow-none',
          'px-1.5 py-1',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isOpening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
        )}
      >
        <button
          onClick={handleAddToChat}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md',
            'text-sm font-medium',
            'text-[var(--surface-foreground)]',
            'hover:bg-[var(--interactive-hover)]',
            'transition-colors duration-150'
          )}
          title="Add to current chat"
          type="button"
        >
          <RiAddLine className="h-4 w-4" />
          <span className="whitespace-nowrap">Add to chat</span>
        </button>
      
        <div className="w-px h-4 bg-[var(--interactive-border)]" />
      
        <button
          onClick={handleCreateNewSession}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md',
            'text-sm font-medium',
            'text-[var(--surface-foreground)]',
            'hover:bg-[var(--interactive-hover)]',
            'transition-colors duration-150'
          )}
          title="Create new session with selection"
          type="button"
        >
          <RiChatNewLine className="h-4 w-4" />
          <span className="whitespace-nowrap">New session</span>
        </button>
      </div>
    </div>,
    document.body
  );
};

export default TextSelectionMenu;
