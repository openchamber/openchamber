/**
 * Structured context attached to an outgoing message.
 *
 * Every user-attached context item — an inline code comment, a terminal
 * selection, a browser annotation, a GitHub PR comment or failed check, a
 * linked issue or PR — is sent as its own synthetic text part. The part's
 * `text` is what the model reads; the part's `metadata[CONTEXT_METADATA_KEY]`
 * carries the same information structured, so the timeline can render the
 * context as a dedicated block after the message round-trips through the
 * OpenCode server (which persists part metadata verbatim).
 *
 * This module owns both directions: building the part at send time and
 * parsing the metadata back at render time. Keeping them together is what
 * guarantees they cannot drift apart.
 */

import { z } from 'zod';
import type { TextPart } from '@opencode-ai/sdk/v2';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { appendTerminalContexts } from './terminalContext';

export const CONTEXT_METADATA_KEY = 'openchamberContext';

export type CodeCommentContext = {
    kind: 'code-comment';
    source: 'diff' | 'file' | 'plan';
    fileLabel: string;
    startLine: number;
    endLine: number;
    side?: 'original' | 'modified';
    language: string;
    code: string;
    text: string;
};

type TerminalContextPayload = {
    kind: 'terminal';
    terminalId: string;
    terminalLabel: string;
    startLine: number;
    endLine: number;
    output: string;
};

type BrowserAnnotationContext = {
    kind: 'browser-annotation';
    pageUrl: string;
    /** The full annotation prompt shown to the model. */
    prompt: string;
    text: string;
};

type PrCommentContext = {
    kind: 'pr-comment';
    label: string;
    body: string;
    text: string;
};

type PrCheckContext = {
    kind: 'pr-check';
    label: string;
    output: string;
    text: string;
};

type GitHubIssueContext = {
    kind: 'github-issue';
    number: number;
    title: string;
    url: string;
};

type FileQuoteContext = {
    kind: 'file-quote';
    fileLabel: string;
    /** Present when the fragment could be located in the file source. */
    startLine?: number;
    endLine?: number;
    quote: string;
    text: string;
};

type ChatQuoteContext = {
    kind: 'chat-quote';
    /** The message the quote came from, when known. */
    messageId?: string;
    quote: string;
    text: string;
};

type GitHubPrContext = {
    kind: 'github-pr';
    number: number;
    title: string;
    url: string;
};

export type ContextPartPayload =
    | CodeCommentContext
    | TerminalContextPayload
    | BrowserAnnotationContext
    | PrCommentContext
    | PrCheckContext
    | FileQuoteContext
    | ChatQuoteContext
    | GitHubIssueContext
    | GitHubPrContext;

export type ContextPartMetadata = { [K in typeof CONTEXT_METADATA_KEY]: ContextPartPayload };

export type ContextPart = {
    text: string;
    synthetic: true;
    metadata: ContextPartMetadata;
};

/**
 * The model-facing text for a context payload. The wording intentionally
 * matches what OpenChamber sent before parts carried metadata, so model
 * behavior does not change with the transport format.
 */
export function formatContextText(payload: ContextPartPayload): string {
    switch (payload.kind) {
        case 'code-comment': {
            const range = `lines ${payload.startLine}-${payload.endLine}`;
            const sideNote = payload.source === 'diff' && payload.side ? ` (${payload.side})` : '';
            return `Comment on \`${payload.fileLabel}\` ${range}${sideNote}:\n\`\`\`${payload.language}\n${payload.code}\n\`\`\`\n\n${payload.text}`;
        }
        case 'terminal':
            return appendTerminalContexts('', [{
                terminalId: payload.terminalId,
                terminalLabel: payload.terminalLabel,
                startLine: payload.startLine,
                endLine: payload.endLine,
                text: payload.output,
            }]);
        case 'browser-annotation':
            return payload.text ? `${payload.prompt}\n\n${payload.text}` : payload.prompt;
        case 'pr-comment':
            return `Attached GitHub PR comment (${payload.label}):\n\n${payload.body}${payload.text ? `\n\n${payload.text}` : ''}`;
        case 'file-quote': {
            const location = payload.startLine != null && payload.endLine != null
                ? ` lines ${payload.startLine}-${payload.endLine}`
                : '';
            const quoted = payload.quote.split('\n').map((line) => `> ${line}`).join('\n');
            return `Comment on this fragment of \`${payload.fileLabel}\`${location}:\n${quoted}${payload.text ? `\n\n${payload.text}` : ''}`;
        }
        case 'chat-quote': {
            const quoted = payload.quote.split('\n').map((line) => `> ${line}`).join('\n');
            return `Comment on this fragment of an earlier message in this conversation:\n${quoted}${payload.text ? `\n\n${payload.text}` : ''}`;
        }
        case 'pr-check':
            return `Attached failed GitHub PR check (${payload.label}):\n\`\`\`\n${payload.output}\n\`\`\`${payload.text ? `\n\n${payload.text}` : ''}`;
        case 'github-issue':
        case 'github-pr':
            // Linked issues/PRs carry server-fetched context text built by
            // their pickers; there is no default text to derive here.
            return '';
    }
}

/**
 * Build the synthetic part for one context payload. `text` overrides the
 * derived text; github-issue/github-pr payloads require it because their
 * model-facing context is fetched by the picker, not derived from metadata.
 */
export function createContextPart(payload: ContextPartPayload, text?: string): ContextPart {
    const resolvedText = text ?? formatContextText(payload);
    return {
        text: resolvedText,
        synthetic: true,
        metadata: { [CONTEXT_METADATA_KEY]: payload },
    };
}

/** Map a composer context draft to its structured payload. */
export function contextPayloadFromDraft(draft: InlineCommentDraft): ContextPartPayload {
    switch (draft.source) {
        case 'terminal':
            return {
                kind: 'terminal',
                terminalId: draft.terminalId ?? '',
                terminalLabel: draft.fileLabel,
                startLine: draft.startLine,
                endLine: draft.endLine,
                output: draft.code,
            };
        case 'preview-annotation':
            return {
                kind: 'browser-annotation',
                pageUrl: draft.fileLabel,
                prompt: draft.code,
                text: draft.text,
            };
        case 'pr-comment':
            return { kind: 'pr-comment', label: draft.fileLabel, body: draft.code, text: draft.text };
        case 'pr-check':
            return { kind: 'pr-check', label: draft.fileLabel, output: draft.code, text: draft.text };
        case 'file-quote': {
            const payload: FileQuoteContext = { kind: 'file-quote', fileLabel: draft.fileLabel, quote: draft.code, text: draft.text };
            if (draft.startLine > 0 && draft.endLine > 0) {
                payload.startLine = draft.startLine;
                payload.endLine = draft.endLine;
            }
            return payload;
        }
        case 'chat-quote': {
            const payload: ChatQuoteContext = { kind: 'chat-quote', quote: draft.code, text: draft.text };
            if (draft.fileLabel) payload.messageId = draft.fileLabel;
            return payload;
        }
        case 'diff':
        case 'file':
        case 'plan': {
            const payload: CodeCommentContext = {
                kind: 'code-comment',
                source: draft.source,
                fileLabel: draft.fileLabel,
                startLine: draft.startLine,
                endLine: draft.endLine,
                language: draft.language,
                code: draft.code,
                text: draft.text,
            };
            if (draft.source === 'diff' && draft.side) payload.side = draft.side;
            return payload;
        }
    }
}

// ---------------------------------------------------------------------------
// Read-back: parsing part metadata at the display boundary
// ---------------------------------------------------------------------------

const contextPayloadSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('code-comment'),
        source: z.enum(['diff', 'file', 'plan']),
        fileLabel: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        side: z.enum(['original', 'modified']).optional(),
        language: z.string(),
        code: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('terminal'),
        terminalId: z.string(),
        terminalLabel: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        output: z.string(),
    }),
    z.object({
        kind: z.literal('browser-annotation'),
        pageUrl: z.string(),
        prompt: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('pr-comment'),
        label: z.string(),
        body: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('pr-check'),
        label: z.string(),
        output: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('file-quote'),
        fileLabel: z.string(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        quote: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('chat-quote'),
        messageId: z.string().optional(),
        quote: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('github-issue'),
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
    }),
    z.object({
        kind: z.literal('github-pr'),
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
    }),
]);

/** The subset of a message part that context read-back inspects. */
export type ContextCarrierPart = { type: string } & Pick<TextPart, 'metadata'>;

/**
 * Read the structured context payload from a message part, if it carries one.
 * The part comes from the server or an optimistic insert, so the payload is
 * schema-validated before it is trusted.
 */
export function readContextPart(part: ContextCarrierPart): ContextPartPayload | null {
    if (part.type !== 'text') return null;
    const parsed = contextPayloadSchema.safeParse(part.metadata?.[CONTEXT_METADATA_KEY]);
    return parsed.success ? parsed.data : null;
}
