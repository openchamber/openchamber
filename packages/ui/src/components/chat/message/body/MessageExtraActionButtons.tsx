import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { MessageExtraAction } from './messageBodyProps';

/**
 * Extension actions on desktop live behind one apps button, the same way the
 * touch sheets already fold every action away, so several extensions never
 * stretch the hover row.
 */
export const MessageExtraActionButtons: React.FC<{ actions?: MessageExtraAction[] }> = ({ actions }) => {
    const { t } = useI18n();
    if (!actions || actions.length === 0) return null;
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t('chat.messageBody.actions.moreActions')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <Icon name="apps" className="h-3.5 w-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.moreActions')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
                {actions.map((action) => (
                    <DropdownMenuItem key={action.id} className="typography-meta" onSelect={() => action.onSelect()}>
                        <span className="flex items-center gap-2 min-w-0">
                            <span className="flex size-4 shrink-0 items-center justify-center">{action.icon}</span>
                            <span className="truncate">{action.label}</span>
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
