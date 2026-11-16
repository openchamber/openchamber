import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionMessages } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subagentDescription } from '@/lib/opencode/tools';
import { toBackgroundSubagentPart, toStoppedSubagentPart, type BackgroundSubagentPhase } from '../backgroundSubagentPart';
import { findSubagentCancellation, findSubagentRun, readBackgroundSubagentChildID } from '@/lib/opencode/subagent-run';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import type { ToolPartProps, ToolRowHeader } from './types';
import { useSubagentChildSessionId } from './subagentChildSession';
import { ToolPartContent } from './ToolPartContent';

/**
 * A subagent call. The row follows the child: a background call is rebuilt
 * from the child's status and report (see `backgroundSubagentPart.ts`), and a
 * call the user stopped reads as stopped instead of failed. While the child
 * runs the row offers the same stop the background shell rows do.
 */
export const SubagentToolPartContent: React.FC<ToolPartProps> = (props) => {
    const { t } = useI18n();
    const directory = useEffectiveDirectory();
    const childSessionID = useSubagentChildSessionId(props.part, directory ?? '');
    const backgroundChildID = readBackgroundSubagentChildID(props.part);
    const status = props.part.state.status;
    // The parent's messages carry the background report and the stop note;
    // a foreground call that runs or succeeded needs neither.
    const needsMessages = backgroundChildID !== undefined || status === 'error';
    const messages = useSessionMessages(needsMessages ? props.part.sessionID : '', directory);
    const run = React.useMemo(
        () => (backgroundChildID ? findSubagentRun(messages, backgroundChildID) : undefined),
        [backgroundChildID, messages],
    );
    const stoppedByUser = React.useMemo(
        () => childSessionID !== undefined && findSubagentCancellation(messages, childSessionID),
        [childSessionID, messages],
    );
    const backgroundRunning = useGlobalSessionStatusStore((state) => backgroundChildID !== undefined && state.activeSessionIds.has(backgroundChildID));
    const [stopping, setStopping] = React.useState(false);

    const backgroundPhase = React.useMemo((): BackgroundSubagentPhase | undefined => {
        if (!backgroundChildID) return undefined;
        if (run) return { kind: 'finished', run };
        return backgroundRunning ? { kind: 'running' } : { kind: 'unknown' };
    }, [backgroundChildID, backgroundRunning, run]);

    const part = React.useMemo(() => {
        if (backgroundPhase) return toBackgroundSubagentPart(props.part, backgroundPhase);
        return stoppedByUser ? toStoppedSubagentPart(props.part, t('chat.toolPart.background.stoppedNotice')) : props.part;
    }, [backgroundPhase, props.part, stoppedByUser, t]);

    const isRunning = backgroundPhase ? backgroundPhase.kind === 'running' : status === 'running';
    const description = subagentDescription(props.part.state.input);
    const stop = React.useCallback(() => {
        if (!childSessionID) return;
        setStopping(true);
        opencodeClient.stopSubagent({
            sessionID: props.part.sessionID,
            directory,
            childSessionID,
            description,
        }).catch(() => {
            setStopping(false);
            toast.error(t('chat.toolPart.subagent.stopFailed'));
        });
    }, [childSessionID, description, directory, props.part.sessionID, t]);

    const stopped = backgroundPhase
        ? backgroundPhase.kind === 'finished' && backgroundPhase.run.state === 'cancelled'
        : stoppedByUser;
    const header: ToolRowHeader = {
        // "in background" describes a call still running; a finished one is just finished.
        label: stopped ? 'stopped' : backgroundPhase?.kind === 'running' ? 'background' : undefined,
        durationUnknown: backgroundPhase?.kind === 'unknown',
        stop: isRunning && childSessionID && !stopping
            ? { onStop: stop, ariaLabel: t('chat.toolPart.subagent.stop') }
            : undefined,
    };

    return <ToolPartContent {...props} part={part} header={header} subagentSessionId={childSessionID} />;
};
