import React from 'react';

import { hasMarkdownWindow, holdMarkdownBlocks } from '@/components/chat/markdown/markdownWindow';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { readPreviewHeadings, type PreviewHeading } from './markdownPreviewHeadings';

/** Marks the toolbar control that opens and closes the outline, so its own click is not an outside click. */
const OUTLINE_TOGGLE_ATTRIBUTE = 'data-markdown-outline-toggle';

type MarkdownPreviewOutlineProps = {
  /** The scrollable preview container whose rendered headings are listed. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Layout overrides for the floating panel (position, offsets). */
  className?: string;
};

/**
 * The headings of the rendered Markdown preview, filtered as you type; picking
 * one scrolls the preview to it. A sibling of the scroll container and never a
 * child, so its own text is not part of the document it lists.
 */
export const MarkdownPreviewOutline: React.FC<MarkdownPreviewOutlineProps> = ({
  containerRef,
  open,
  onOpenChange,
  className,
}) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [headings, setHeadings] = React.useState<PreviewHeading[]>([]);
  const [query, setQuery] = React.useState('');

  // A long document mounts only the blocks near the view. The outline lists
  // every heading, so the blocks stay mounted while it is open (as for the
  // find bar), and the list follows the rendered document as it changes. The
  // renderer loads lazily and may mount after the panel opened, so the hold is
  // taken on the first scan that finds its window.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) return;
    setQuery('');
    let releaseBlocks: (() => void) | null = null;
    const scan = () => {
      if (!releaseBlocks && hasMarkdownWindow(container)) releaseBlocks = holdMarkdownBlocks(container);
      setHeadings(readPreviewHeadings(container));
    };
    scan();
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      releaseBlocks?.();
    };
  }, [containerRef, open]);

  const close = React.useCallback(() => {
    onOpenChange(false);
    // The preview keeps keyboard focus, so the find shortcut still reaches it.
    containerRef.current?.focus({ preventScroll: true });
  }, [containerRef, onOpenChange]);

  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !panelRef.current || panelRef.current.contains(target)) return;
      // The toolbar button closes the panel with its own click; closing here
      // first would let that click open it again.
      if (target.closest(`[${OUTLINE_TOGGLE_ATTRIBUTE}]`)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onOpenChange, open]);

  const select = React.useCallback((heading: PreviewHeading) => {
    heading.element.scrollIntoView({ block: 'start' });
    close();
  }, [close]);

  if (!open) return null;

  // A document that starts at level 2 is not indented as if a level 1 sat above it.
  const shallowest = headings.reduce((lowest, heading) => Math.min(lowest, heading.level), 6);

  return (
    <div
      ref={panelRef}
      className={cn(
        'absolute inset-s-3 top-3 z-40 w-[min(28rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-lg',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <Command
        loop
        // Values are `text\u0000index`; only the text is matched.
        filter={(value, search) => (value.split('\u0000')[0].toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
        className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1 [&_[cmdk-item]]:typography-meta"
      >
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={t('filesView.preview.outline.placeholder')}
          aria-label={t('filesView.preview.outline.placeholder')}
        />
        <CommandList className="max-h-[min(20rem,calc(100vh-16rem))]">
          <CommandEmpty className="px-3 py-4 typography-meta text-muted-foreground">
            {headings.length === 0 ? t('filesView.preview.outline.noHeadings') : t('filesView.preview.outline.noMatches')}
          </CommandEmpty>
          {headings.map((heading, index) => (
            <CommandItem
              key={index}
              value={`${heading.text}\u0000${index}`}
              onSelect={() => select(heading)}
            >
              <span
                data-heading-depth={heading.level - shallowest}
                className="min-w-0 flex-1 truncate text-foreground"
                style={{ paddingInlineStart: `${(heading.level - shallowest) * 12}px` }}
              >
                {heading.text}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
};
