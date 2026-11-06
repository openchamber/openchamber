import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { useSessionDirectory } from '@/sync/sync-context';

export type PageDecline = 'idle' | 'sending' | 'declined';

/**
 * Ends a page's wait without an answer, so the user does not have to pick
 * something they do not mean to move on. The server stops the native turn.
 * While it is sent the page takes no answer, so the two cannot race.
 */
export function usePageDecline(sessionId: string, callId: string): [PageDecline, () => void] {
    const { t } = useI18n();
    const directory = useSessionDirectory(sessionId);
    const [state, setState] = React.useState<PageDecline>('idle');
    const decline = React.useCallback(async () => {
        setState('sending');
        try {
            await answerRenderedPage({ sessionId, callId, declined: true }, directory);
            setState('declined');
        } catch (error) {
            setState('idle');
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
        }
    }, [callId, directory, sessionId, t]);
    return [state, () => void decline()];
}
