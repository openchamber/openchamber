import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const GitDrillHeader: React.FC<{
  backLabel: string;
  onBack: () => void;
  title: string;
  meta: React.ReactNode;
  actions?: React.ReactNode;
  focusOnMount?: boolean;
  onFocused?: () => void;
}> = ({ backLabel, onBack, title, meta, actions, focusOnMount = false, onFocused }) => (
  <div className="flex shrink-0 items-center gap-1 border-b border-edge-muted py-1.5 ps-1.5 pe-2">
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          onClick={onBack}
          aria-label={backLabel}
          ref={(node) => {
            if (!node || !focusOnMount) return;
            node.focus();
            onFocused?.();
          }}
        >
          <Icon name="arrow-left" className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>{backLabel}</TooltipContent>
    </Tooltip>
    <div className="min-w-0 flex-1 ps-0.5">
      <div dir="auto" className="oc-ui-start-align truncate typography-ui-label font-semibold text-foreground" title={title}>
        {title}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">{meta}</div>
    </div>
    {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
  </div>
);
