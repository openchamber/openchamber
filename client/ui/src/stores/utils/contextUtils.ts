export const calculateContextUsage = (
    totalTokens: number,
    contextLimit: number,
    outputLimit: number
) => {
    const safeContext = Number.isFinite(contextLimit) ? Math.max(contextLimit, 0) : 0;
    const hasOutputLimit = Number.isFinite(outputLimit) && outputLimit > 0;
    const safeOutput = hasOutputLimit ? Math.max(outputLimit, 0) : 0;

    const effectiveOutputReservation = Math.min(hasOutputLimit ? safeOutput : 32000, 32000);
    const normalizedOutput = Math.min(effectiveOutputReservation, safeContext);
    const thresholdLimit = safeContext > 0 ? Math.max(safeContext - normalizedOutput, 1) : 0;
    const percentage = thresholdLimit > 0 ? (totalTokens / thresholdLimit) * 100 : 0;

    return {
        percentage: Math.min(percentage, 100),
        contextLimit: safeContext,
        outputLimit: safeOutput,
        thresholdLimit: thresholdLimit || 1,
        normalizedOutput
    };
};