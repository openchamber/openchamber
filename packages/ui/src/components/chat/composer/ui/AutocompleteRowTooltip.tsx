import React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface AutocompleteRowTooltipProps {
  description?: string;
  active: boolean;
  children: React.ReactElement;
}

export function AutocompleteRowTooltip({ description, active, children }: AutocompleteRowTooltipProps) {
  const [delayedActive, setDelayedActive] = React.useState(false);

  React.useEffect(() => {
    if (!active || !description) {
      setDelayedActive(false);
      return;
    }

    const timeout = window.setTimeout(() => setDelayedActive(true), 200);
    return () => window.clearTimeout(timeout);
  }, [active, description]);

  if (!description) return children;

  return (
    <Tooltip delayDuration={0} open={active && delayedActive} onOpenChange={() => {}}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {active && delayedActive ? (
        <TooltipContent
          side="right"
          sideOffset={8}
          className="max-w-xs text-left transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100"
        >
          <p className="typography-meta whitespace-pre-wrap">{description}</p>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
