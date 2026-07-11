import React from 'react';
import { loadBrandDisplayFont } from '@/lib/fontLoader';
import { useSidebarBrandStore } from '@/stores/useSidebarBrandStore';

/**
 * Left-sidebar wordmark, rendered above the Recent section.
 *
 * Dual-tone like Codex branding: leading words use the surface foreground and
 * the final word uses the primary accent. Set in Syne (geometric display face)
 * with open tracking so it reads as a mark rather than body UI text.
 *
 * The configured text is split on whitespace: all but its final word use the
 * normal foreground and the final word uses the theme accent. Brand copy is
 * user content, so it is intentionally not localized.
 *
 * An empty (whitespace-only) config hides the mark entirely — no default
 * fallback — so that logo slot stays vacant.
 */
export const SidebarBrandMark: React.FC = () => {
  const sidebarBrandName = useSidebarBrandStore((state) => state.sidebarBrandName);

  React.useEffect(() => {
    void loadBrandDisplayFont();
  }, []);

  // Empty config → no custom logo; leave the sidebar brand slot empty.
  const brandWords = sidebarBrandName.trim().split(/\s+/).filter(Boolean);
  if (brandWords.length === 0) {
    return null;
  }

  const leadingWords = brandWords.slice(0, -1);
  const highlightedWord = brandWords.at(-1);

  return (
    <div className="px-2 pb-2 pt-1">
      <span
        aria-label={brandWords.join(' ')}
        className="inline-flex min-w-0 items-baseline gap-[0.28em] truncate"
        style={{
          fontFamily: '"Syne", var(--font-sans, system-ui, sans-serif)',
          fontSize: '1.0625rem',
          fontWeight: 700,
          letterSpacing: '0.08em',
          lineHeight: 1,
        }}
      >
        {leadingWords.length > 0 && <span className="text-foreground">{leadingWords.join(' ')}</span>}
        {highlightedWord && <span className="text-primary">{highlightedWord}</span>}
      </span>
    </div>
  );
};
