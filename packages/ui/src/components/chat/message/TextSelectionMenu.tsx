import React from 'react';
import { createPortal } from 'react-dom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { RiBookletLine, RiChatNewLine, RiAddLine, RiFileCopyLine, RiLoader4Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import { getProjectNotesAndTodos, saveProjectNotesAndTodos } from '@/lib/openchamberConfig';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { summarizeText } from '@/lib/voice/summarize';
import { isVSCodeRuntime } from '@/lib/desktop';

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
}


const appendDistilledInsightToNotes = (existingNotes: string, insight: string): string => {
  const trimmedInsight = insight.trim().replace(/^[-*+]\s+/, '');
  if (!trimmedInsight) {
    return existingNotes;
  }

  const trimmedNotes = existingNotes.trimEnd();
  return trimmedNotes ? `${trimmedNotes}\n${trimmedInsight}` : trimmedInsight;
};

const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

const normalizeLineBreaks = (value: string): string => value.replace(/\r\n?/g, '\n');

const trimSelectionValue = (value: string): string => normalizeLineBreaks(value).trim();

const textToMarkdownInline = (value: string): string => value.replace(/\s+/g, ' ').trim();

const renderInlineMarkdownNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return textToMarkdownInline(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const childText = Array.from(element.childNodes)
    .map((child) => renderInlineMarkdownNode(child))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!childText && tag !== 'br') {
    return '';
  }

  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${childText}**`;
  if (tag === 'em' || tag === 'i') return `*${childText}*`;
  if (tag === 'code') return `\`${childText.replace(/`/g, '\\`')}\``;
  if (tag === 'a') {
    const href = element.getAttribute('href');
    return href ? `[${childText}](${href})` : childText;
  }

  return childText;
};

const renderListMarkdown = (list: HTMLElement, ordered: boolean): string => {
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li'
  );

  return items
    .map((item, index) => {
      const prefix = ordered ? `${index + 1}. ` : '- ';
      const body = Array.from(item.childNodes)
        .map((child) => renderInlineMarkdownNode(child))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return body ? `${prefix}${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
};

const renderBlockMarkdownNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return trimSelectionValue(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();

  if (tag === 'pre') {
    const codeElement = element.querySelector('code');
    const languageClass = codeElement?.className || '';
    const language = (languageClass.match(/language-([\w-]+)/)?.[1] || '').trim();
    const code = normalizeLineBreaks(codeElement?.textContent || element.textContent || '').replace(/\n$/, '');
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  if (tag === 'code') {
    const code = normalizeLineBreaks(element.textContent || '').trim();
    return code ? `\`${code.replace(/`/g, '\\`')}\`` : '';
  }

  if (tag === 'ul') return renderListMarkdown(element, false);
  if (tag === 'ol') return renderListMarkdown(element, true);

  if (tag === 'blockquote') {
    const content = trimSelectionValue(
      Array.from(element.childNodes).map((child) => renderBlockMarkdownNode(child)).join('\n')
    );
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `> ${line}`)
      .join('\n');
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number.parseInt(tag[1], 10);
    const text = trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }

  if (tag === 'p' || tag === 'div' || tag === 'li') {
    return trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
  }

  const blockChildren = Array.from(element.childNodes)
    .map((child) => renderBlockMarkdownNode(child))
    .filter((child) => child.length > 0);
  if (blockChildren.length > 0) {
    return blockChildren.join('\n\n');
  }

  return trimSelectionValue(Array.from(element.childNodes).map((child) => renderInlineMarkdownNode(child)).join(''));
};

const isInlineSelectionFragment = (fragment: DocumentFragment): boolean => {
  return Array.from(fragment.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }

    const element = node as HTMLElement;
    return !BLOCK_TAGS.has(element.tagName.toLowerCase());
  });
};

const rangeToMarkdown = (range: Range, plainText: string): string => {
  const fragment = range.cloneContents();

  if (isInlineSelectionFragment(fragment)) {
    const inlineMarkdown = trimSelectionValue(
      Array.from(fragment.childNodes)
        .map((node) => renderInlineMarkdownNode(node))
        .join('')
    );
    if (inlineMarkdown) {
      return inlineMarkdown;
    }
  }

  const markdown = Array.from(fragment.childNodes)
    .map((node) => renderBlockMarkdownNode(node))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();

  return markdown || trimSelectionValue(plainText);
};

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ containerRef }) => {
  const [position, setPosition] = React.useState<MenuPosition>({ x: 0, y: 0, show: false });
  const [selectedText, setSelectedText] = React.useState('');
  const [selectedTextMarkdown, setSelectedTextMarkdown] = React.useState('');
  const isDraggingRef = React.useRef(false);
  const [isOpening, setIsOpening] = React.useState(false);
  const [isAddingToNotes, setIsAddingToNotes] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuWidthRef = React.useRef(DESKTOP_MENU_FALLBACK_WIDTH_PX);
  const pendingSelectionRef = React.useRef<SelectionPayload | null>(null);
  const openRafRef = React.useRef<number | null>(null);
  const isMenuVisibleRef = React.useRef(false);
  const createSession = useSessionUIStore((state) => state.createSession);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
  const isMobile = useUIStore((state) => state.isMobile);
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const effectiveDirectory = useEffectiveDirectory();
  const sessions = useSessions();

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
    setSelectedTextMarkdown('');
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

    const { plainText, markdownText, rect } = pendingSelectionRef.current;
    const shouldAnimateIn = !position.show;

    // Position menu above the selection
    const menuX = isMobile
      ? rect.left + rect.width / 2
      : getDesktopClampedX(rect.left + rect.width / 2);
    const menuY = rect.top - 10;

    setSelectedText(plainText);
    setSelectedTextMarkdown(markdownText);
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
    pendingSelectionRef.current = {
      plainText: text,
      markdownText: rangeToMarkdown(range, text),
      rect,
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
    const handleMouseDown = () => {
      isDraggingRef.current = true;
      hideMenu();
    };

    // Track when dragging stops
    const handleMouseUp = () => {
      isDraggingRef.current = false;
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
    if (!selectedTextMarkdown) return;

    const markdownBlock = `\`\`\`md\n${selectedTextMarkdown}\n\`\`\``;
    setPendingInputText(markdownBlock, 'append');
    
    hideMenu();
    
    // Clear selection
    window.getSelection()?.removeAllRanges();
  }, [selectedTextMarkdown, setPendingInputText, hideMenu]);

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
        toast.error('No project found for this session');
      }
      return;
    }

    try {
      setIsAddingToNotes(true);
      const distilledInsight = await summarizeText(selectedText, {
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });
      const projectData = await getProjectNotesAndTodos(currentProjectRef);
      const nextNotes = appendDistilledInsightToNotes(projectData.notes, distilledInsight);
      const saved = await saveProjectNotesAndTodos(currentProjectRef, {
        notes: nextNotes,
        todos: projectData.todos,
      });
      if (!saved) {
        toast.error('Failed to add to notes');
        return;
      }
      window.dispatchEvent(new CustomEvent('openchamber:project-notes-updated', {
        detail: { projectId: currentProjectRef.id },
      }));
      toast.success('Added distilled insight to notes');
      hideMenu();
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      const description = error instanceof Error ? error.message : undefined;
      toast.error('Failed to add to notes', description ? { description } : undefined);
    } finally {
      setIsAddingToNotes(false);
    }
  }, [currentProjectRef, hideMenu, selectedText]);

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

        {!isVSCodeRuntime() ? (
          <button
            onClick={handleAddToNotes}
            disabled={isAddingToNotes}
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-lg',
              'text-sm font-medium',
              'bg-[var(--surface-muted)] text-[var(--surface-foreground)]',
              'active:opacity-80 disabled:opacity-60 disabled:cursor-not-allowed',
              'transition-opacity duration-150'
            )}
            type="button"
          >
            {isAddingToNotes ? <RiLoader4Line className="h-5 w-5 animate-spin" /> : <RiBookletLine className="h-5 w-5" />}
            <span>Add to notes</span>
          </button>
        ) : null}
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

        {!isVSCodeRuntime() ? (
          <>
            <div className="w-px h-4 bg-[var(--interactive-border)]" />

            <button
              onClick={handleAddToNotes}
              disabled={isAddingToNotes}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-md',
                'text-sm font-medium',
                'text-[var(--surface-foreground)]',
                'hover:bg-[var(--interactive-hover)] disabled:opacity-60 disabled:cursor-not-allowed',
                'transition-colors duration-150'
              )}
              title="Save distilled insight to notes"
              type="button"
            >
              {isAddingToNotes ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiBookletLine className="h-4 w-4" />}
              <span className="whitespace-nowrap">Add to notes</span>
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
};

export default TextSelectionMenu;
