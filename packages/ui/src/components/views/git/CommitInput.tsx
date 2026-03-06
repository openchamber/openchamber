import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/useLanguage';

interface CommitInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hasTouchInput?: boolean;
}

const MIN_HEIGHT = 38; // Single line height
const MAX_HEIGHT = 200;

export const CommitInput: React.FC<CommitInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  hasTouchInput = false,
}) => {
  const { t } = useLanguage();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const effectivePlaceholder = placeholder || t('commitSection.commitMessagePlaceholder');

  // Auto-resize based on content (layout phase to avoid mount flicker)
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to measure scrollHeight accurately
    textarea.style.height = `${MIN_HEIGHT}px`;
    const contentHeight = textarea.scrollHeight;
    const newHeight = Math.min(Math.max(contentHeight, MIN_HEIGHT), MAX_HEIGHT);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = contentHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={effectivePlaceholder}
      rows={1}
      disabled={disabled}
      autoCorrect={hasTouchInput ? 'on' : 'off'}
      autoCapitalize={hasTouchInput ? 'sentences' : 'off'}
      spellCheck={hasTouchInput ? true : false}
      scrollbarClassName="hidden"
      className={cn(
        'rounded-lg bg-transparent resize-none overflow-y-hidden',
        disabled && 'opacity-50'
      )}
      style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
    />
  );
};
