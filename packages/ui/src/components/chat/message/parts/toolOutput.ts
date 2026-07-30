export const getToolOutput = (
    tool: string,
    stateOutput: unknown,
    metadataOutput: unknown,
): string | undefined => {
    if (typeof stateOutput === 'string') {
        return stateOutput;
    }

    if (tool === 'bash' && typeof metadataOutput === 'string' && metadataOutput.length > 0) {
        return metadataOutput;
    }

    return undefined;
};

export const getStreamingOutputAppend = (previous: string, next: string): string | undefined => {
    return next.startsWith(previous) ? next.slice(previous.length) : undefined;
};
