import React from 'react';

import { useI18n } from '@/lib/i18n';
import type { Part } from '@/lib/opencode/model';
import { isFileChangeTool } from '@/lib/opencode/tools';
import { countActivityGroup } from '../lib/turns/activityGroups';
import { summarizeLiveActivity, type LiveActivitySummary } from '../lib/turns/liveActivitySummary';
import type { ChatMessageEntry } from '../lib/turns/types';

export type ActivityKind = 'edit' | 'run' | 'explore' | 'other';

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

export interface ActivityDescription {
    files: number;
    countsComplete: boolean;
    labels: string[];
    summary: LiveActivitySummary;
    kind: ActivityKind;
}

export const useActivityDescription = (messages: readonly ChatMessageEntry[], parts: readonly Part[]): ActivityDescription => {
    const { t } = useI18n();
    const counts = React.useMemo(() => countActivityGroup(parts), [parts]);
    const summary = React.useMemo(() => summarizeLiveActivity(messages), [messages]);
    const pending = pendingFileCount(parts, summary.changedFiles);
    const files = summary.files + pending;
    const labels: string[] = [];
    if (counts.commands > 0) labels.push(t(counts.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: counts.commands }));
    if (counts.subagents > 0) labels.push(t(counts.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: counts.subagents }));
    if (counts.explored) labels.push(t('chat.liveActivity.explored'));
    if (counts.searchedWeb) labels.push(t('chat.liveActivity.researched'));
    const calls = parts.filter((part) => part.type === 'tool').length;
    if (labels.length === 0 && calls > 0 && files === 0) labels.push(t(calls === 1 ? 'chat.activityGroup.step' : 'chat.activityGroup.steps', { count: calls }));
    let kind: ActivityKind = 'other';
    if (files > 0) kind = 'edit';
    else if (counts.commands > 0) kind = 'run';
    else if (counts.explored || counts.searchedWeb) kind = 'explore';
    return { files, countsComplete: pending === 0 && summary.hasCompleteDiff, labels, summary, kind };
};

export const isActivityDescribed = ({ files, labels }: ActivityDescription): boolean => files > 0 || labels.length > 0;
