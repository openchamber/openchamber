import React from 'react';
import { useGuestToolPresentation } from '@/lib/guests/tool-presentation';
import { isExecuteTool, soleNamedCall, soleDirectCall } from '@/lib/opencode/tools';
import type { ToolPartProps } from './types';

/**
 * Most of OpenChamber's own tools run behind Code Mode, so their calls arrive
 * as `execute` parts. A script that made just one of those calls reads as that
 * tool's own row: its action, detail and icon, instead of "execute" and a
 * list of tool names. Everything else about the part stays the script's.
 *
 * The same goes for a sole call to a tool an active extension has a rule for:
 * the row is the one a direct call of that tool gets, found under the tool's
 * direct name. Only a finished script gets it: a running one can still make
 * another call, and the row would then lose the tool's identity mid-run. A
 * failed call or a failed script keeps the script row, the only one that
 * shows what went wrong.
 */
export const useShownToolPart = (part: ToolPartProps['part']): ToolPartProps['part'] => {
    const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
    const sole = React.useMemo(
        () => (isExecuteTool(part.tool) ? soleNamedCall(metadata) : undefined),
        [metadata, part.tool],
    );
    const finished = part.state.status === 'completed';
    const direct = React.useMemo(
        () => (!sole && finished && isExecuteTool(part.tool) ? soleDirectCall(metadata) : undefined),
        [finished, metadata, part.tool, sole],
    );
    const ruled = useGuestToolPresentation(direct?.tool) ? direct : undefined;
    const shown = sole ?? ruled;
    return React.useMemo(
        () => (shown ? { ...part, tool: shown.tool, state: { ...part.state, input: shown.input } } : part),
        [part, shown],
    );
};
