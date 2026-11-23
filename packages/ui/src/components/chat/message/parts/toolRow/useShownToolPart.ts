import React from 'react';
import { useGuestToolPresentation } from '@/lib/guests/tool-presentation';
import { isExecuteTool, soleNamedCall, soleDirectCall } from '@/lib/opencode/tools';
import type { ToolPartProps } from './types';

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
