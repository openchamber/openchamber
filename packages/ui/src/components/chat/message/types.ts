export type StreamPhase = 'streaming' | 'cooldown' | 'completed';

export type DiffViewMode = 'side-by-side' | 'unified';

export interface AgentMentionInfo {
    name: string;
    token: string;
}

export interface ToolPopupContent {
    open: boolean;
    title: string;
    content: string;
    language?: string;
    isDiff?: boolean;
    diffHunks?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
    image?: {
        url: string;
        mimeType?: string;
        filename?: string;
        size?: number;
        /** The image's own bytes, to save it; without it only a `data:` or `blob:` URL can be saved. */
        load?: () => Promise<Blob>;
        gallery?: Array<{
            url: string;
            mimeType?: string;
            filename?: string;
            size?: number;
            load?: () => Promise<Blob>;
        }>;
        index?: number;
    };
    mermaid?: {
        url: string;
        mimeType?: string;
        filename?: string;
        source?: string;
    };
}
