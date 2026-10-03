import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

/** The tooltip waits a beat: the button sits next to text the user reads while the agent works. */
const TOOLTIP_DELAY_MS = 750;

/**
 * "Move to background" for the work the agent is blocked on. Shared by the
 * status chip above the composer and the scroll-to-bottom pill that stands in
 * for it, so both carry the same action, label and shortcut.
 */
export const BackgroundWorkButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className }) => {
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const shortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('background_session_work', shortcutOverrides));
    const label = t('chat.statusRow.background.action');

    return (
        <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onClick();
                    }}
                    aria-label={label}
                    className={cn(
                        'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors',
                        'hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        className,
                    )}
                >
                    <Icon name="arrow-up-double" className="h-4 w-4" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {label}
                {shortcut ? <span className="ml-2 text-muted-foreground">{shortcut}</span> : null}
            </TooltipContent>
        </Tooltip>
    );
};
