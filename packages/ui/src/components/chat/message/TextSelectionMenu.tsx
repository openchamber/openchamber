import React from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { RiChatNewLine, RiAddLine, RiFileCopyLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useLanguage } from '@/hooks/useLanguage';

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLElement | null>;
}

interface MenuPosition {
  x: number;
  y: number;
  show: boolean;
}

const MENU_TRANSITION_MS = 200;

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef }) => {
  const { t } = useLanguage();
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, show: false });
  const [selectedText, setSelectedText] = React.useState('');
  const [isDragging, setIsDragging] = React.useState(false);
  const [isClosing, setIsClosing] = React.useState(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const pendingSelectionRef = React.useRef<{ text: string; rect: DOMRect } | null>(null);
  const hideTimeoutRef = React.useRef<number | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const createSession = useSessionStore((state) => state.createSession);
  const setPendingInputText = useSessionStore((state) => state.setPendingInputText);
  const isMobile = useUIStore((state) => state.isMobile);

  React.useEffect(() => {
    return () => {
      if (hideTimeoutRef.current !== null) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      if (openRafRef.current !== null) {
        window.cancelAnimationFrame(openRafRef.current);
        openRafRef.current = null;
      }
    };
  }, []);

  const hideMenu = React.useCallback(() => {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (openRafRef.current !== null) {
      window.cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    setIsOpening(false);

    setIsClosing(true);
    hideTimeoutRef.current = window.setTimeout(() => {
      setPosition((prev) => ({ ...prev, show: false }));
      setSelectedText('');
      pendingSelectionRef.current = null;
      setIsClosing(false);
      hideTimeoutRef.current = null;
    }, MENU_TRANSITION_MS);
  }, []);

  const showMenu = React.useCallback(() => {
    if (!pendingSelectionRef.current) return;

    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setIsClosing(false);

    const { text, rect } = pendingSelectionRef.current;
    const shouldAnimateIn = !position.show;

    // Position menu above the selection
    const menuX = rect.left + rect.width / 2;
    const menuY = rect.top - 10;

    setSelectedText(text);
    setPosition({
      x: menuX,
      y: menuY,
      show: true,
    });

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
  }, [position.show]);

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

    setPendingInputText(selectedText, 'append');
    
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
          isClosing
            ? 'opacity-0 translate-y-[4px] pointer-events-none'
            : isOpening
              ? 'opacity-0 translate-y-[4px]'
              : 'opacity-100 translate-y-0'
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
          <span>{t('textSelectionMenu.addToChat')}</span>
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
          <span>{t('textSelectionMenu.newSession')}</span>
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
          <span>{t('common.copy')}</span>
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
          'flex items-center gap-1',
          'rounded-lg border border-[var(--interactive-border)]',
          'bg-[var(--surface-elevated)] shadow-none',
          'px-1.5 py-1',
          'transition-[opacity,transform] duration-200 ease-out will-change-[opacity,transform]',
          isClosing
            ? 'opacity-0 translate-y-[4px] pointer-events-none'
            : isOpening
              ? 'opacity-0 translate-y-[4px]'
              : 'opacity-100 translate-y-0'
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
          title={t('textSelectionMenu.addToCurrentChat')}
          type="button"
        >
          <RiAddLine className="h-4 w-4" />
          <span>{t('textSelectionMenu.addToChat')}</span>
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
          title={t('textSelectionMenu.createSessionWithSelection')}
          type="button"
        >
          <RiChatNewLine className="h-4 w-4" />
          <span>{t('textSelectionMenu.newSession')}</span>
        </button>
      </div>
    </div>,
    document.body
  );
};

export default TextSelectionMenu;
