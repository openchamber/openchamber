import React from 'react';
import { useParentSessionBack } from '@/hooks/useParentSessionBack';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useParentSession } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';

export const ReturnToParentButton: React.FC<{
    sessionId: string | null;
    directory: string | undefined;
    hidden: boolean;
    openSession: (sessionId: string, directory: string | null) => void;
    registerParentSessionBack?: (handler: (() => void) | null) => void;
}> = ({ sessionId, directory, hidden, openSession, registerParentSessionBack }) => {
    const { t } = useI18n();
    const parentSession = useParentSession(sessionId, directory);
    const handleReturnToParentSession = useParentSessionBack(parentSession, hidden, openSession, registerParentSessionBack);

    if (!parentSession || hidden) return null;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={handleReturnToParentSession}
                    className="absolute inset-s-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
                    aria-label={t('chat.container.returnToParent.aria')}
                >
                    <Icon name="arrow-left" className="h-4 w-4" />
                    {t('chat.container.returnToParent.label')}
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
                {parentSession.title?.trim()
                    ? t('chat.container.returnToParent.titleNamed', { title: parentSession.title })
                    : t('chat.container.returnToParent.title')}
            </TooltipContent>
        </Tooltip>
    );
};
