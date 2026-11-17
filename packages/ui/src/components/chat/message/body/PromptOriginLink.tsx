import React from 'react';
import type { Session } from '@/lib/opencode/model';
import type { PromptOrigin } from '@/lib/opencode/prompt-origin';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useSessionSelector } from '@/sync/sync-context';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { INLINE_TEXT_LINK_STYLE, USER_BUBBLE_TEXT_LINK_CLASS } from './userBubbleLinkStyle';

const TITLE_SLOT = '\u0000';
const selectSessionTitle = (session: Session | undefined): string | undefined => session?.title?.trim() || undefined;

export const PromptOriginLink: React.FC<{ origin: PromptOrigin }> = ({ origin }) => {
    const { t } = useI18n();
    const liveTitle = useSessionSelector(origin.sessionID, undefined, selectSessionTitle);
    const title = liveTitle ?? origin.title;
    const open = (event: React.MouseEvent) => {
        event.stopPropagation();
        void openSessionLink(origin.sessionID, null);
    };
    if (!title) {
        return (
            <button type="button" onClick={open} className={cn('min-w-0 truncate', USER_BUBBLE_TEXT_LINK_CLASS)} style={INLINE_TEXT_LINK_STYLE}>
                {t('chat.message.userText.promptedByUnknown')}
            </button>
        );
    }
    const [before, after = ''] = t('chat.message.userText.promptedBy', { title: TITLE_SLOT }).split(TITLE_SLOT);
    return (
        <span className="flex min-w-0 items-center whitespace-pre">
            {before ? <span className="shrink-0">{before}</span> : null}
            <button
                type="button"
                onClick={open}
                className={cn('min-w-0 truncate', USER_BUBBLE_TEXT_LINK_CLASS)}
                style={INLINE_TEXT_LINK_STYLE}
                title={title}
                dir="auto"
            >
                {title}
            </button>
            {after ? <span className="shrink-0">{after}</span> : null}
        </span>
    );
};
