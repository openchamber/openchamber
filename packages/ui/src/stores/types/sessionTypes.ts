export type SessionWorktreeAttachment = {
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  worktreeSource: 'existing' | 'created-for-session' | null;
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
};

export interface AttachedFile {
    id: string;
    file: File;
    dataUrl: string;
    mimeType: string;
    filename: string;
    size: number;
    source: "local" | "server" | "vscode";
    serverPath?: string;
    vscodePath?: string;
    vscodeSource?: 'file' | 'selection';
    agentPath?: string;
    sourceDocumentId?: string;
    saveOnSend?: boolean;
    saveCopyOnSend?: boolean;
    original?: { mimeType: string; dataUrl: string; saveOnSend?: boolean };
}

export type EditPermissionMode = 'allow' | 'ask' | 'deny' | 'full';

export type MessageStreamPhase = 'streaming' | 'cooldown' | 'completed';

export interface SessionHistoryMeta {
    limit: number;
    complete: boolean;
    loading: boolean;
}

interface SessionContextLimits {
    contextLimit: number;
    outputLimit?: number;
    thresholdLimit: number;
    lastMessageId?: string;
}

export type SessionContextUsage =
    | (SessionContextLimits & {
        state: 'measured';
        totalTokens: number;
        percentage: number;
        normalizedOutput?: number;
    })
    | (SessionContextLimits & { state: 'compacted' });

const DEFAULT_MESSAGE_LIMIT = 200;
const MEMORY_CONSTANTS = {
    MAX_SESSIONS: 3,
    ZOMBIE_TIMEOUT: 10 * 60 * 1000,
} as const;

const getMessageLimit = (): number => {
    return DEFAULT_MESSAGE_LIMIT;
};

export const getBackgroundTrimLimit = (): number =>
    Math.round(getMessageLimit() * 0.6);

const DEFAULT_MEMORY_LIMITS = {
    MAX_SESSIONS: MEMORY_CONSTANTS.MAX_SESSIONS,
    VIEWPORT_MESSAGES: Math.round(DEFAULT_MESSAGE_LIMIT * 0.6),
    HISTORICAL_MESSAGES: DEFAULT_MESSAGE_LIMIT,
    FETCH_BUFFER: 20,
    HISTORY_CHUNK: DEFAULT_MESSAGE_LIMIT,
    STREAMING_BUFFER: Infinity,
    ZOMBIE_TIMEOUT: MEMORY_CONSTANTS.ZOMBIE_TIMEOUT,
} as const;

export const getMemoryLimits = () => {
    const limit = getMessageLimit();
    const bgTrim = getBackgroundTrimLimit();
    return {
        ...DEFAULT_MEMORY_LIMITS,
        HISTORICAL_MESSAGES: limit,
        VIEWPORT_MESSAGES: bgTrim,
        HISTORY_CHUNK: limit,
    };
};

export const MEMORY_LIMITS = DEFAULT_MEMORY_LIMITS;
