const ACTIVE_TOOL_STATUSES = new Set([
    'pending',
    'running',
    'started',
    'inprogress',
    'processing',
    'executing',
]);

const FINAL_TOOL_STATUSES = new Set([
    'completed',
    'complete',
    'error',
    'failed',
    'aborted',
    'timeout',
    'timedout',
    'done',
    'cancelled',
    'canceled',
]);

const readTimestamp = (value: unknown): number | undefined => {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const normalizeToolStatus = (status: unknown): string | undefined => {
    if (typeof status !== 'string') {
        return undefined;
    }

    const normalized = status.toLowerCase().trim().replace(/[\s_-]+/g, '');
    return normalized.length > 0 ? normalized : undefined;
};

export const isActiveToolStatus = (status: unknown): boolean => {
    const normalized = normalizeToolStatus(status);
    return normalized ? ACTIVE_TOOL_STATUSES.has(normalized) : false;
};

export const isFinalToolStatus = (status: unknown): boolean => {
    const normalized = normalizeToolStatus(status);
    return normalized ? FINAL_TOOL_STATUSES.has(normalized) : false;
};

export type ToolLifecycleState = {
    status?: string;
    start?: number;
    end?: number;
    hasStarted: boolean;
    hasEnded: boolean;
    isStatusActive: boolean;
    isStatusFinal: boolean;
    isInFlight: boolean;
    isFinalized: boolean;
};

export const getToolLifecycleState = (
    state?: { status?: unknown; time?: { start?: unknown; end?: unknown } } | null,
): ToolLifecycleState => {
    const status = normalizeToolStatus(state?.status);
    const start = readTimestamp(state?.time?.start);
    const rawEnd = readTimestamp(state?.time?.end);
    const hasEnded = typeof rawEnd === 'number' && (typeof start !== 'number' || rawEnd >= start);
    const end = hasEnded ? rawEnd : undefined;
    const isStatusActive = status ? ACTIVE_TOOL_STATUSES.has(status) : false;
    const isStatusFinal = status ? FINAL_TOOL_STATUSES.has(status) : false;
    const isUnknownNonFinal = status ? !isStatusActive && !isStatusFinal : true;
    const isInFlight = !hasEnded && (isStatusActive || isUnknownNonFinal);
    const isFinalized = hasEnded || isStatusFinal;

    return {
        status,
        start,
        end,
        hasStarted: typeof start === 'number',
        hasEnded,
        isStatusActive,
        isStatusFinal,
        isInFlight,
        isFinalized,
    };
};
