import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getLongErrorPreview } from './longErrorPreview';

interface LongErrorTextProps {
  text: string;
  /** Renders the visible part of the error: the preview while collapsed, the full text once expanded. */
  children: (visibleText: string) => React.ReactNode;
  buttonClassName?: string;
}

/**
 * Shows a long error collapsed to its first lines with a button to reveal the
 * rest. Short errors render unchanged. The full text is never rendered while
 * collapsed, so a huge error costs nothing until someone asks to read it.
 */
export const LongErrorText: React.FC<LongErrorTextProps> = ({ text, children, buttonClassName }) => {
  const { t } = useI18n();
  // Remember which error was expanded, so a different error arriving in the
  // same place starts collapsed again.
  const [expandedText, setExpandedText] = React.useState<string | null>(null);
  const expanded = expandedText === text;
  const preview = React.useMemo(() => getLongErrorPreview(text), [text]);
  const contentId = React.useId();

  if (preview === null) return <>{children(text)}</>;

  // aria-live="off": inside a status region, expanding must not make a screen
  // reader read the whole error aloud.
  return (
    <div aria-live="off">
      {/* The full text scrolls inside its own box, so "Show less" stays right under it.
          tabIndex lets keyboard users scroll that box. */}
      <div
        id={contentId}
        tabIndex={expanded ? 0 : undefined}
        className={expanded ? 'max-h-96 overflow-y-auto' : undefined}
      >
        {children(expanded ? text : preview)}
      </div>
      <Button
        variant="link"
        size="xs"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpandedText(expanded ? null : text)}
        className={cn('-ml-2 normal-case', buttonClassName)}
      >
        {expanded ? t('chat.longError.collapse') : t('chat.longError.expand')}
      </Button>
    </div>
  );
};
