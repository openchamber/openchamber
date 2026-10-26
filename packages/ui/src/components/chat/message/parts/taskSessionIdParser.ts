export const readTaskTagSessionIdFromOutput = (output: string): string | undefined => {
    const taskTagMatch = output.match(/<task\s+id="([^"]+)"(?:\s+[^>]*)?>/i);
    return taskTagMatch?.[1];
};
