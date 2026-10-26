import React from 'react';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { buildMessageLink, type MessageLinkForm } from '@/lib/sessionLinks';

// Desktop and the mobile app hand out the native deep link: their own page
// address (a loopback port, a packaged scheme) opens nothing elsewhere. The
// web hands out its own address. VS Code has no link: its extension runs its
// own OpenCode, so a link would open a desktop app that usually lacks the
// session.
const resolveMessageLinkForm = (): MessageLinkForm | null => {
    if (isVSCodeRuntime()) return null;
    if (isDesktopShell() || isCapacitorApp()) return { kind: 'deep-link' };
    return { kind: 'web', origin: window.location.origin, pathname: window.location.pathname };
};

/** "Copy link" for a message, or undefined where this surface has no message links. */
export const useCopyMessageLink = (sessionId: string | undefined, messageId: string): (() => void) | undefined => {
    const { t } = useI18n();
    return React.useMemo(() => {
        const form = sessionId ? resolveMessageLinkForm() : null;
        const link = sessionId && form ? buildMessageLink(sessionId, messageId, form) : null;
        if (!link) return undefined;
        return () => {
            void copyTextToClipboard(link).then((result) => {
                if (result.ok) {
                    toast.success(t('chat.messageBody.toast.linkCopied'));
                } else {
                    toast.error(t('chat.messageBody.toast.linkCopyFailed'));
                }
            });
        };
    }, [messageId, sessionId, t]);
};
