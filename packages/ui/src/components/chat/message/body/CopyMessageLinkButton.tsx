import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/** Copies a link to the message; the toast confirms, as the link is not visible. */
export const CopyMessageLinkButton: React.FC<{ onCopyLink: () => void }> = ({ onCopyLink }) => {
    const { t } = useI18n();
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('chat.messageBody.actions.copyLink')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        onCopyLink();
                    }}
                >
                    <Icon name="link" className="h-3 w-3" />
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyLink')}</TooltipContent>
        </Tooltip>
    );
};
