import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';
import {
    getRailTurnOutlineItems,
    type TurnOutlineItem,
} from './turnHoverOutlineItems';

type TurnHoverOutlineProps = {
    items: TurnOutlineItem[];
    activeTurnId: string | null;
    onJumpTurn: (turnId: string) => void;
    onOpenTimeline: () => void;
};

const CLOSE_DELAY_MS = 120;

export const TurnHoverOutline = React.memo(({
    items,
    activeTurnId,
    onJumpTurn,
    onOpenTimeline,
}: TurnHoverOutlineProps) => {
    const { t } = useI18n();
    const railItems = React.useMemo(() => getRailTurnOutlineItems(items, activeTurnId), [items, activeTurnId]);

    if (items.length === 0) return null;

    return (
        <Popover.Root>
            <Popover.Trigger
                openOnHover
                delay={0}
                closeDelay={CLOSE_DELAY_MS}
                render={
                    <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        aria-label={t('chat.turnOutline.open')}
                        className="flex h-24 w-9 flex-col items-center justify-center gap-[2.5px] rounded-md [corner-shape:round] supports-[corner-shape:squircle]:rounded-md px-0 normal-case font-normal tracking-normal text-inherit bg-[var(--surface-background)]/95 hover:bg-[var(--interactive-hover)] focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                    >
                        {railItems.map((item) => (
                            <span
                                key={item.turnId}
                                data-current={item.turnId === activeTurnId}
                                className="h-0.5 w-4 rounded-full bg-[color-mix(in_srgb,var(--surface-muted-foreground)_40%,transparent)] data-[current=true]:bg-[var(--surface-foreground)]"
                            />
                        ))}
                    </Button>
                }
            />
            <Popover.Portal>
                <Popover.Positioner side="right" align="center" sideOffset={8} collisionPadding={8}>
                    <Popover.Popup
                        style={changedFilesPopoverStyle}
                        className={cn(
                            changedFilesPopoverClassName,
                            'flex w-64 flex-col gap-1 rounded-2xl p-1 transition-all duration-150 ease-out',
                            'data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95',
                        )}
                    >
                        <Popover.Title className="sr-only">{t('chat.turnOutline.open')}</Popover.Title>
                        <div className="max-h-80 overflow-y-auto">
                            {items.map((item) => (
                                <Popover.Close
                                    key={item.turnId}
                                    render={
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            type="button"
                                            aria-current={item.turnId === activeTurnId ? 'location' : undefined}
                                            className="w-full justify-start rounded-xl [corner-shape:round] supports-[corner-shape:squircle]:rounded-xl px-2 text-left typography-small normal-case font-normal tracking-normal text-inherit hover:bg-[var(--interactive-hover)] hover:text-inherit focus-visible:border-transparent focus-visible:ring-0 focus-visible:bg-[var(--interactive-hover)] aria-current:bg-[var(--interactive-selection)] aria-current:text-[var(--interactive-selection-foreground)] aria-current:hover:text-[var(--interactive-selection-foreground)]"
                                            onClick={() => onJumpTurn(item.turnId)}
                                        >
                                            <span className="line-clamp-1 min-w-0">
                                                {item.preview || t('chat.timeline.noTextContent')}
                                            </span>
                                        </Button>
                                    }
                                />
                            ))}
                        </div>
                        <Popover.Close
                            render={
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    type="button"
                                    className="mt-0.5 h-auto min-h-7 justify-start rounded-xl [corner-shape:round] supports-[corner-shape:squircle]:rounded-xl px-2 py-1.5 text-left typography-meta normal-case font-normal tracking-normal text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] focus-visible:border-transparent focus-visible:ring-0 focus-visible:bg-[var(--interactive-hover)]"
                                    onClick={onOpenTimeline}
                                >
                                    {t('chat.turnOutline.openTimeline')}
                                </Button>
                            }
                        />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
});

TurnHoverOutline.displayName = 'TurnHoverOutline';
