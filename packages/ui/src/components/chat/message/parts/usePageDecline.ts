import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { answerRenderedPage } from '@/lib/renderPageAnswer';

export type PageDecline = 'idle' | 'sending' | 'declined';

export function usePageDecline(sessionId: string, callId: string): [PageDecline, () => void] {
    const { t } = useI18n();
    const [state, setState] = React.useState<PageDecline>('idle');
    const decline = React.useCallback(async () => {
        setState('sending');
        try {
            await answerRenderedPage({ sessionId, callId, declined: true });
            setState('declined');
        } catch (error) {
            setState('idle');
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
        }
    }, [callId, sessionId, t]);
    return [state, () => void decline()];
}
