import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionMessages } from '@/sync/sync-context';
import { useRunningShell } from '@/sync/background-shells';
import { useForegroundShellStopping } from '../foregroundShellStop';
import { findShellCancellation, findShellCompletion } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { toBackgroundShellPart, type BackgroundShellPhase } from '../backgroundShellPart';
import { useShellOutput } from '../useShellOutput';
import type { ToolPartProps } from './types';
import { ToolPartContent } from './ToolPartContent';

export const BackgroundShellToolPartContent: React.FC<ToolPartProps & { shellID: string }> = ({ shellID, ...props }) => {
    const { t } = useI18n();
    const directory = useEffectiveDirectory();
    const running = useRunningShell(shellID);
    const messages = useSessionMessages(props.part.sessionID, directory);
    const completion = React.useMemo(() => findShellCompletion(messages, shellID), [messages, shellID]);
    const cancellation = React.useMemo(() => findShellCancellation(messages, shellID), [messages, shellID]);
    const isRunning = !completion && running !== undefined;
    const liveOutput = useShellOutput(shellID, running?.directory, isRunning && props.isExpanded);
    const [stopping, setStopping] = React.useState(false);
    const stoppedFromForeground = useForegroundShellStopping(shellID);

    const phase = React.useMemo((): BackgroundShellPhase => {
        if (isRunning) return { kind: 'running', output: liveOutput };
        if (cancellation) {
            return { kind: 'stopped', endedAt: completion?.endedAt ?? cancellation.stoppedAt, notice: t('chat.toolPart.background.stoppedNotice') };
        }
        return completion ? { kind: 'finished', completion } : { kind: 'unknown' };
    }, [cancellation, completion, isRunning, liveOutput, t]);
    const part = React.useMemo(() => toBackgroundShellPart(props.part, phase), [phase, props.part]);

    const stop = React.useCallback(() => {
        if (!running) return;
        setStopping(true);
        opencodeClient.stopBackgroundShells({
            sessionID: props.part.sessionID,
            sessionDirectory: directory,
            shells: [{ shellID, shellDirectory: running.directory, command: running.command }],
        }).catch(() => {
            setStopping(false);
            toast.error(t('chat.toolPart.background.stopFailed'));
        });
    }, [directory, props.part.sessionID, running, shellID, t]);

    return (
        <ToolPartContent
            {...props}
            part={part}
            header={{
                label: phase.kind === 'stopped' ? 'stopped' : 'background',
                durationUnknown: phase.kind === 'unknown',
                stop: isRunning && !stopping && !stoppedFromForeground ? { onStop: stop, ariaLabel: t('chat.toolPart.background.stop') } : undefined,
            }}
        />
    );
};
