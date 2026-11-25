import React from 'react';

import { DiffCount } from '@/components/ui/diff-count';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { Part } from '@/lib/opencode/model';
import { countActivityGroup, type ActivityGroupCounts } from '../lib/turns/activityGroups';
import { isFileChangeTool } from '@/lib/opencode/tools';
import { toolDisplayName } from '../message/parts/toolRow/toolDescriptions';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import type { TurnRecord } from '../lib/turns/types';
import { FoldLine } from './FoldLine';

type CountLabel = { count: Exclude<keyof ActivityGroupCounts, 'other' | 'failed'>; one: I18nKey; many: I18nKey };

const COUNT_LABELS: readonly CountLabel[] = [
    { count: 'commands', one: 'chat.liveActivity.ranCommand', many: 'chat.liveActivity.ranCommands' },
    { count: 'reads', one: 'chat.activityGroup.read', many: 'chat.activityGroup.reads' },
    { count: 'searches', one: 'chat.activityGroup.search', many: 'chat.activityGroup.searches' },
    { count: 'web', one: 'chat.activityGroup.webCall', many: 'chat.activityGroup.webCalls' },
    { count: 'skills', one: 'chat.activityGroup.skill', many: 'chat.activityGroup.skills' },
];

const GROUP_LOOK = {
    edit: { icon: 'group-edit' },
    run: { icon: 'group-run' },
    explore: { icon: 'group-explore' },
    other: { icon: 'group-other' },
} as const;

const groupKind = (files: number, counts: ActivityGroupCounts): keyof typeof GROUP_LOOK => {
    if (files > 0) return 'edit';
    if (counts.commands > 0) return 'run';
    return counts.reads + counts.searches + counts.skills + counts.web > 0 ? 'explore' : 'other';
};

const pendingFileCount = (parts: readonly Part[], changed: readonly { path: string }[]): number => {
    const targets = new Set<string>();
    for (const part of parts) {
        if (part.type !== 'tool' || !isFileChangeTool(part.tool) || part.state.status === 'completed' || part.state.status === 'error') continue;
        const input = part.state.input;
        const path = [input.filePath, input.path, input.file_path].find((value) => typeof value === 'string');
        if (typeof path !== 'string') targets.add(part.id);
        else if (!changed.some((file) => file.path.endsWith(path) || path.endsWith(file.path))) targets.add(path);
    }
    return targets.size;
};

export const ActivityGroupLine: React.FC<{ turn: TurnRecord; parts: readonly Part[]; open: boolean; onToggle: () => void }> = ({ turn, parts, open, onToggle }) => {
    const { t } = useI18n();
    const counts = React.useMemo(() => countActivityGroup(parts), [parts]);
    const summary = React.useMemo(() => {
        const ids = new Set(parts.map((part) => part.id));
        return summarizeLiveActivity(turn.assistantMessages.flatMap((message) => {
            const own = message.parts.filter((part) => ids.has(part.id));
            return own.length > 0 ? [{ info: message.info, parts: own }] : [];
        }));
    }, [parts, turn.assistantMessages]);
    const labels = COUNT_LABELS.flatMap(({ count, one, many }) => (counts[count] > 0 ? [t(counts[count] === 1 ? one : many, { count: counts[count] })] : []));
    if (counts.other.size > 0) {
        labels.push([...counts.other].map(([tool, count]) => (count > 1 ? `${toolDisplayName(tool, t)} \u00d7${count}` : toolDisplayName(tool, t))).join(', '));
    }
    const files = summary.files + pendingFileCount(parts, summary.changedFiles);
    const kind = groupKind(files, counts);
    return (
        <FoldLine icon={GROUP_LOOK[kind].icon} open={open} onToggle={onToggle}>
            {files > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-[var(--tools-title)]">
                    {t(files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: files })}
                    {summary.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? <DiffCount added={summary.additions} removed={summary.deletions} /> : null}
                </span>
            ) : null}
            <span className="min-w-0 truncate">
                {files > 0 ? null : <span className="text-[var(--tools-title)]">{labels[0]}</span>}
                {files > 0 ? labels.map((label) => ` · ${label}`) : labels.slice(1).map((label) => ` · ${label}`)}
            </span>
            {counts.failed > 0 ? (
                <span className="shrink-0 text-[var(--status-error)]">{t('chat.activityGroup.failed', { count: counts.failed })}</span>
            ) : null}
        </FoldLine>
    );
};
