import React from 'react';
import type { ToolPart as ToolPartType } from '@/lib/opencode/model';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRunningShell } from '@/sync/background-shells';
import { stopForegroundShell, useForegroundShellStopping } from '../foregroundShellStop';
import { readRunningShellID } from '@/lib/opencode/background-shell';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { toInterruptedShellPart } from '../backgroundShellPart';
import { useShellOutput } from '../useShellOutput';
import type { ToolPartProps, ToolRowHeader } from './types';
import { ToolPartContent } from './ToolPartContent';

/**
 * A shell call the turn waits for. OpenCode reports only the command's id
 * while it runs, so the expanded row reads the output from the shell service,
 * as a background row does, until the call settles with its final output.
 */
export const ShellToolPartContent: React.FC<ToolPartProps> = (props) => {
    const { t } = useI18n();
    const directory = useEffectiveDirectory();
    const shellID = readRunningShellID(props.part);
    const running = useRunningShell(shellID);
    const stopping = useForegroundShellStopping(shellID);
    const liveOutput = useShellOutput(shellID ?? '', running?.directory, shellID !== undefined && props.isExpanded);
    const interrupted = props.part.state.status === 'error' && props.part.state.metadata?.interrupted === true;
    const part = React.useMemo((): ToolPartType => {
        const { state } = props.part;
        if (interrupted) return toInterruptedShellPart(props.part, t('chat.toolPart.background.stoppedNotice'));
        if (!liveOutput || state.status !== 'running') return props.part;
        return { ...props.part, state: { ...state, metadata: { ...state.metadata, output: liveOutput } } };
    }, [interrupted, liveOutput, props.part, t]);

    // Stopped through the background (see `foregroundShellStop.ts`). The
    // index's `background` flag is not checked: a list read sets it for a
    // command this call may still wait for.
    const stop = React.useCallback(() => {
        if (!running) return;
        stopForegroundShell({
            sessionID: props.part.sessionID,
            sessionDirectory: directory,
            shell: { shellID: running.id, shellDirectory: running.directory, command: running.command },
        }).catch(() => {
            toast.error(t('chat.toolPart.background.stopFailed'));
        });
    }, [directory, props.part.sessionID, running, t]);

    const header: ToolRowHeader | undefined = interrupted
        ? { label: 'stopped' }
        : running && !stopping
            ? { stop: { onStop: stop, ariaLabel: t('chat.toolPart.background.stop') } }
            : undefined;

    return <ToolPartContent {...props} part={part} header={header} />;
};
