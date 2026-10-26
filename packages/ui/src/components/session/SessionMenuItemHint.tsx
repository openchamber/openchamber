import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Long enough that scanning down a menu shows nothing; resting on an item explains it. */
const SESSION_MENU_HINT_DELAY_MS = 500;

/**
 * A short explanation beside a session menu item, shown after the pointer
 * rests on it and gone as soon as it leaves. Each hint is its own tooltip
 * group, so the next item waits again instead of opening at once. A menu
 * focuses the item under the pointer, and a tooltip opens on focus without
 * delay, so focus never opens a hint.
 */
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
