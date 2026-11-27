import React from 'react';

import { DiffCount } from '@/components/ui/diff-count';
import { useI18n } from '@/lib/i18n';
import type { Part } from '@/lib/opencode/model';
import type { TurnRecord } from '../lib/turns/types';
import { useActivityDescription, type ActivityDescription, type ActivityKind } from './activityDescription';
import { FoldLine } from './FoldLine';

const GROUP_ICON = {
    edit: 'group-edit',
    run: 'group-run',
    explore: 'group-explore',
    other: 'group-other',
} as const satisfies Record<ActivityKind, string>;

export const ActivityDescriptionText: React.FC<{ description: ActivityDescription }> = ({ description: { files, countsComplete, labels, summary } }) => {
    const { t } = useI18n();
    return (
        <>
            {files > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-[var(--tools-title)]">
                    {t(files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: files })}
                    {countsComplete && (summary.additions > 0 || summary.deletions > 0) ? <DiffCount added={summary.additions} removed={summary.deletions} /> : null}
                </span>
            ) : null}
            <span className="min-w-0 truncate" title={labels.join(' · ')}>
                {files > 0 ? null : <span className="text-[var(--tools-title)]">{labels[0]}</span>}
                {files > 0 ? labels.map((label) => ` · ${label}`) : labels.slice(1).map((label) => ` · ${label}`)}
            </span>
        </>
    );
};

export const ActivityGroupLine: React.FC<{ turn: TurnRecord; parts: readonly Part[]; open: boolean; onToggle: () => void }> = ({ turn, parts, open, onToggle }) => {
    const messages = React.useMemo(() => {
        const ids = new Set(parts.map((part) => part.id));
        return turn.assistantMessages.flatMap((message) => {
            const own = message.parts.filter((part) => ids.has(part.id));
            return own.length > 0 ? [{ info: message.info, parts: own }] : [];
        });
    }, [parts, turn.assistantMessages]);
    const description = useActivityDescription(messages, parts);
    return (
        <FoldLine icon={GROUP_ICON[description.kind]} open={open} onToggle={onToggle}>
            <ActivityDescriptionText description={description} />
        </FoldLine>
    );
};
