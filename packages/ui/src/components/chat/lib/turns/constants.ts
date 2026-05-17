export const ACTIVITY_STANDALONE_TOOL_NAMES = new Set<string>(['task']);

export const HIDDEN_INTERNAL_TOOL_NAMES = new Set<string>(['todowrite', 'todoread']);

export const TURN_WINDOW_DEFAULTS = {
    initialTurns: 7,
    batchTurns: 7,
    prefetchBuffer: 16,
} as const;

export const TURN_TEXT_THROTTLE_DEFAULT_MS = 100;
