import React from 'react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

interface CommitInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hasTouchInput?: boolean;
  isMobile?: boolean;
}

const MIN_HEIGHT = 38; // Single line height
const MAX_HEIGHT = 200;

export const CommitInput: React.FC<CommitInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  hasTouchInput = false,
  isMobile = false,
}) => {
  const { t } = useI18n();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);

  // Auto-resize based on content (layout phase to avoid mount flicker)
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const hadFocus = document.activeElement === textarea;

    const resize = () => {
      // Reset to baseline to measure content height from a stable line.
      textarea.style.height = `${MIN_HEIGHT}px`;
      const contentHeight = textarea.scrollHeight;
      const newHeight = Math.min(Math.max(contentHeight, MIN_HEIGHT), MAX_HEIGHT);
      textarea.style.height = `${newHeight}px`;
      textarea.style.overflowY = contentHeight > MAX_HEIGHT ? 'auto' : 'hidden';

      if (contentHeight > MAX_HEIGHT && !hadFocus) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    resize();
    const frameId = window.requestAnimationFrame(resize);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? t('gitView.commit.messagePlaceholder')}
      rows={1}
      disabled={disabled}
      autoCorrect={hasTouchInput ? 'on' : 'off'}
      autoCapitalize={hasTouchInput ? 'sentences' : 'off'}
      spellCheck={isMobile || inputSpellcheckEnabled}
      className={cn(
        'w-full rounded-lg border border-border/60 bg-surface-elevated px-3 py-2 typography-ui-label text-foreground placeholder:text-muted-foreground',
        'resize-none outline-none transition-[border-color,box-shadow] duration-150',
        'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        disabled && 'opacity-50'
      )}
      style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
    />
  );
};
