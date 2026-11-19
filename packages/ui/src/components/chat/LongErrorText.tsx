import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getLongErrorPreview } from './longErrorPreview';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface LongErrorTextProps {
  text: string;
  children: (visibleText: string) => React.ReactNode;
  buttonClassName?: string;
}

export const LongErrorText: React.FC<LongErrorTextProps> = ({ text, children, buttonClassName }) => {
  const { t } = useI18n();
  const [expandedText, setExpandedText] = React.useState<string | null>(null);
  const expanded = expandedText === text;
  const preview = React.useMemo(() => getLongErrorPreview(text), [text]);
  const contentId = React.useId();

  if (preview === null) return <>{children(text)}</>;

  return (
    <div aria-live="off">
      <ScrollableOverlay
        id={contentId}
        tabIndex={expanded ? 0 : undefined}
        outerClassName={expanded ? 'max-h-96' : undefined}
        disableHorizontal
      >
        {children(expanded ? text : preview)}
      </ScrollableOverlay>
      <Button
        variant="link"
        size="xs"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpandedText(expanded ? null : text)}
        className={cn('-ms-2 normal-case', buttonClassName)}
      >
        {expanded ? t('chat.longError.collapse') : t('chat.longError.expand')}
      </Button>
    </div>
  );
};
