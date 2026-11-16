import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const SESSION_MENU_HINT_DELAY_MS = 500;

export function SessionMenuItemHint({ hint, children }: { hint: string; children: React.ReactElement }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip
      delayDuration={SESSION_MENU_HINT_DELAY_MS}
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason === 'trigger-focus') return;
        setOpen(next);
      }}
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}
