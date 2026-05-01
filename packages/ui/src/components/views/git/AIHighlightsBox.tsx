import React from 'react';
import { RiArrowDownLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

interface AIHighlightsBoxProps {
  highlights: string[];
  onInsert: (highlights: string[]) => void;
}

export const AIHighlightsBox: React.FC<AIHighlightsBoxProps> = ({
  highlights,
  onInsert,
}) => {
  const { t } = useI18n();
  if (highlights.length === 0) {
    return null;
  }

  const handleInsert = () => {
    onInsert(highlights);
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-transparent px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="typography-micro text-muted-foreground">{t('gitView.commit.aiHighlights.title')}</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleInsert}
              aria-label={t('gitView.commit.aiHighlights.insertAria')}
            >
              <RiArrowDownLine className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>
            {t('gitView.commit.aiHighlights.insertTooltip')}
          </TooltipContent>
        </Tooltip>
      </div>
      <ul className="space-y-1">
        {highlights.map((highlight, index) => (
          <li key={`${highlight}-${index}`} className="typography-meta text-foreground">
            {highlight}
          </li>
        ))}
      </ul>
    </div>
  );
};
