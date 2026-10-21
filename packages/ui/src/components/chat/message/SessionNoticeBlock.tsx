/**
 * One session notice (`@/lib/opencode/session-notices`): a folded line with an
 * info icon and what happened, opening to the text the model received. It
 * draws the same inside a turn's Activity and between turns.
 */

import React from 'react';

import { useI18n } from '@/lib/i18n';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import type { SessionNotice } from '@/lib/opencode/session-notices';
import { useConfigStore } from '@/stores/useConfigStore';
import { ReasoningTimelineBlock } from './parts/ReasoningPart';

// A worktree reads by its folder name; the full path is in the expanded text.
const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** The catalog name of the model a session was handed to, or its id when the catalog does not know it. */
const useHandoffModelName = (notice: SessionNotice): string | null => useConfigStore((state) => {
    if (notice.kind !== 'handoff') return null;
    const provider = state.providers.find((candidate) => candidate.id === notice.providerID);
    return getProviderModelDisplayName(provider, notice.modelID) || notice.modelID;
});

const useNoticeTitle = (notice: SessionNotice): string => {
    const { t } = useI18n();
    const handoffModelName = useHandoffModelName(notice);
    switch (notice.kind) {
        case 'plugin':
            return notice.label;
        case 'restart':
            return t('chat.sessionNotice.restart');
        case 'command-failed':
            return t('chat.sessionNotice.commandFailed', { command: notice.command });
        case 'moved':
            return notice.folder
                ? t('chat.sessionNotice.moved', { folder: folderName(notice.folder) })
                : t('chat.sessionNotice.movedUnknown');
        case 'handoff':
            return t('chat.sessionNotice.handoff', { model: handoffModelName ?? notice.modelID });
    }
};

export const SessionNoticeBlock: React.FC<{ notice: SessionNotice; blockId: string }> = ({ notice, blockId }) => {
    const { t } = useI18n();
    const title = useNoticeTitle(notice);
    const failed = notice.kind === 'command-failed';
    return (
        <ReasoningTimelineBlock
            text={notice.text}
            blockId={blockId}
            presentation={{
                icon: failed ? 'error-warning' : 'information',
                iconClassName: failed ? 'text-[var(--status-error)]' : undefined,
                title,
                expandLabel: t('chat.sessionNotice.showDetails'),
                collapseLabel: t('chat.sessionNotice.hideDetails'),
                markdownVariant: 'assistant',
                maxHeightClassName: 'max-h-[60vh]',
            }}
        />
    );
};
