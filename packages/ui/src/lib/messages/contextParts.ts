
import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { SourceControlProvider } from '@/lib/api/types';
import type { JsonValue } from '@openchamber/sdk';
import type { Metadata } from '@/lib/opencode/model';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { chatQuoteAnchorSchema, type ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { appendTerminalContexts } from './terminalContext';
import { describeDiffCommentOrigin, diffCommentOriginSchema, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';

export const CONTEXT_METADATA_KEY = 'openchamberContext';
const OPENCODE_COMMENT_METADATA_KEY = 'opencodeComment';

export type CodeCommentContext = {
    kind: 'code-comment';
    source: 'diff' | 'file' | 'plan';
    fileLabel: string;
    startLine: number;
    endLine: number;
    side?: 'original' | 'modified';
    language: string;
    code: string;
    changedCode?: string;
    text: string;
    origin?: DiffCommentOrigin;
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
    prompt: string;
    text: string;
};

type PrCommentContext = {
    kind: 'pr-comment';
    label: string;
    body: string;
    text: string;
    provider?: SourceControlProvider;
};

type PrCheckContext = {
    kind: 'pr-check';
    label: string;
    output: string;
    text: string;
    provider?: SourceControlProvider;
};

type RepositoryIssueContext = {
    kind: 'repository-issue';
    provider?: SourceControlProvider;
    number: number;
    title: string;
    url: string;
};

type RepositoryDiscussionContext = {
    kind: 'repository-discussion';
    provider: SourceControlProvider;
    number: number;
    title: string;
    url: string;
};

type FileQuoteContext = {
    kind: 'file-quote';
    fileLabel: string;
    startLine?: number;
    endLine?: number;
    quote: string;
    text: string;
};

type ChatQuoteContext = {
    kind: 'chat-quote';
    messageId?: string;
    anchor?: ChatQuoteAnchor;
    quote: string;
    text: string;
};

type ChangeRequestContext = {
    kind: 'change-request';
    provider?: SourceControlProvider;
    number: number;
    title: string;
    url: string;
    sourceLinks?: string[];
};

type TrackerItemContext = {
    kind: 'tracker-item';
    provider: string;
    identifier: string;
    title: string;
    url: string;
};

type GuestIssueContext = {
    kind: 'guest-issue';
    providerId: string;
    id: string;
    title: string;
    url: string;
    data?: JsonValue;
};

type GuestPrContext = {
    kind: 'guest-pr';
    providerId: string;
    id: string;
    title: string;
    url: string;
    data?: JsonValue;
};

type SessionContext = {
    kind: 'session';
    sessionId: string;
    title: string;
    messageId?: string;
};

type SessionMessageContext = {
    kind: 'session-message';
    sessionId: string;
    messageId: string;
    sessionTitle: string;
    excerpt: string;
};

type SharedPageContext = {
    kind: 'shared-page';
    receivedId: string | null;
    host: string;
    title: string;
    opened: boolean;
};

export type ContextPartPayload =
    | SharedPageContext
    | CodeCommentContext
    | TerminalContextPayload
    | BrowserAnnotationContext
    | PrCommentContext
    | PrCheckContext
    | FileQuoteContext
    | ChatQuoteContext
    | RepositoryIssueContext
    | RepositoryDiscussionContext
    | ChangeRequestContext
    | TrackerItemContext
    | GuestIssueContext
    | GuestPrContext
    | SessionContext
    | SessionMessageContext;

type OpenCodeCommentMetadata = {
    path: string;
    selection?: { startLine: number; endLine: number; startChar?: number; endChar?: number };
    comment: string;
    preview?: string;
    origin?: 'file' | 'review';
};

export type ContextPartMetadata = {
    [CONTEXT_METADATA_KEY]: ContextPartPayload;
    [OPENCODE_COMMENT_METADATA_KEY]?: OpenCodeCommentMetadata;
};

export type ContextPart = {
    text: string;
    metadata: ContextPartMetadata;
};

function changeRequestNoun(provider: SourceControlProvider | undefined): string {
    if (!provider) return 'pull request';
    const { label, terminology } = readSourceControlProvider(provider);
    return `${label} ${terminology.promptNoun}`;
}

export function changeRequestCommentSource(provider: SourceControlProvider | undefined): string {
    return `${changeRequestNoun(provider)} comment`;
}

export function changeRequestCheckSource(provider: SourceControlProvider | undefined): string {
    const ci = provider ? readSourceControlProvider(provider).terminology.ci : 'checks';
    return `${changeRequestNoun(provider)} ${ci === 'pipeline' ? 'pipeline job' : 'check'}`;
}

// Selections read as the user's own words to the agent: a bare "Comment on <file>" header
// read like a review comment from someone else, and models drafted replies to it.
const userWords = (text: string | undefined, subject: string) => (
    text ? `\n\nThe user wrote this to you about ${subject}:\n${text}` : ''
);

export function formatContextText(payload: ContextPartPayload): string {
    switch (payload.kind) {
        case 'code-comment': {
            const originNote = payload.origin ? ` ${describeDiffCommentOrigin(payload.origin)}` : '';
            if (payload.startLine === 0 && payload.endLine === 0) {
                return `The user wrote this to you about \`${payload.fileLabel}\` (the whole file)${originNote}:\n\n${payload.text}`;
            }
            const range = `lines ${payload.startLine}-${payload.endLine}`;
            const sideNote = payload.source === 'diff' && payload.side ? ` (${payload.side})` : '';
            const quoted = `The user selected \`${payload.fileLabel}\` ${range}${sideNote}${originNote}:\n\`\`\`${payload.language}\n${payload.code}\n\`\`\``;
            const now = payload.changedCode === undefined
                ? ''
                : payload.changedCode
                    ? `\n\nThe file changed after the user selected these lines, and the quoted code is no longer there. These lines now hold:\n\`\`\`${payload.language}\n${payload.changedCode}\n\`\`\``
                    : '\n\nThe file changed after the user selected these lines, and the quoted code is no longer there.';
            return `${quoted}${now}${userWords(payload.text, 'these lines')}`;
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
            return `Attached ${changeRequestCommentSource(payload.provider)} (${payload.label}):\n\n${payload.body}${payload.text ? `\n\n${payload.text}` : ''}`;
        case 'file-quote': {
            const location = payload.startLine != null && payload.endLine != null
                ? ` lines ${payload.startLine}-${payload.endLine}`
                : '';
            const quoted = payload.quote.split('\n').map((line) => `> ${line}`).join('\n');
            return `The user selected this fragment of \`${payload.fileLabel}\`${location}:\n${quoted}${userWords(payload.text, 'it')}`;
        }
        case 'chat-quote': {
            const quoted = payload.quote.split('\n').map((line) => `> ${line}`).join('\n');
            return `The user selected this fragment of an earlier message in this conversation:\n${quoted}${userWords(payload.text, 'it')}`;
        }
        case 'pr-check':
            return `Attached failed ${changeRequestCheckSource(payload.provider)} (${payload.label}):\n\`\`\`\n${payload.output}\n\`\`\`${payload.text ? `\n\n${payload.text}` : ''}`;
        case 'repository-issue':
        case 'repository-discussion':
        case 'change-request':
        case 'tracker-item':
        case 'guest-issue':
        case 'guest-pr':
        case 'session':
        case 'session-message':
        case 'shared-page':
            return '';
    }
}

export function createContextPart(payload: ContextPartPayload, text?: string): ContextPart {
    const resolvedText = text ?? formatContextText(payload);
    const metadata: ContextPartMetadata = { [CONTEXT_METADATA_KEY]: payload };
    if (payload.kind === 'code-comment') {
        const comment: OpenCodeCommentMetadata = {
            path: payload.fileLabel,
            comment: payload.text,
            preview: payload.code,
            origin: payload.source === 'diff' ? 'review' : 'file',
        };
        if (payload.startLine !== 0 || payload.endLine !== 0) {
            comment.selection = { startLine: payload.startLine, endLine: payload.endLine, startChar: 0, endChar: 0 };
        }
        metadata[OPENCODE_COMMENT_METADATA_KEY] = comment;
    }
    return {
        text: resolvedText,
        metadata,
    };
}

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
            return { kind: 'pr-comment', label: draft.fileLabel, body: draft.code, text: draft.text, ...(draft.provider ? { provider: draft.provider } : {}) };
        case 'pr-check':
            return { kind: 'pr-check', label: draft.fileLabel, output: draft.code, text: draft.text, ...(draft.provider ? { provider: draft.provider } : {}) };
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
            if (draft.anchor) payload.anchor = draft.anchor;
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
            if (draft.changedCode !== undefined) payload.changedCode = draft.changedCode;
            if (draft.source === 'diff' && draft.side) payload.side = draft.side;
            if (draft.source === 'diff' && draft.origin) payload.origin = draft.origin;
            return payload;
        }
    }
}


const canonicalContextPayloadSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('shared-page'),
        receivedId: z.string().min(1).nullable(),
        host: z.string(),
        title: z.string(),
        opened: z.boolean(),
    }),
    z.object({
        kind: z.literal('code-comment'),
        source: z.enum(['diff', 'file', 'plan']),
        fileLabel: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        side: z.enum(['original', 'modified']).optional(),
        language: z.string(),
        code: z.string(),
        changedCode: z.string().optional(),
        text: z.string(),
        origin: diffCommentOriginSchema.optional(),
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
        provider: sourceControlProviderIdSchema.optional(),
    }),
    z.object({
        kind: z.literal('pr-check'),
        label: z.string(),
        output: z.string(),
        text: z.string(),
        provider: sourceControlProviderIdSchema.optional(),
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
        anchor: chatQuoteAnchorSchema.optional(),
        quote: z.string(),
        text: z.string(),
    }),
    z.object({
        kind: z.literal('repository-issue'),
        provider: sourceControlProviderIdSchema.optional(),
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
    }),
    z.object({
        kind: z.literal('repository-discussion'),
        provider: sourceControlProviderIdSchema,
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
    }),
    z.object({
        kind: z.literal('change-request'),
        provider: sourceControlProviderIdSchema.optional(),
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
        sourceLinks: z.array(z.string()).optional(),
    }),
    z.object({
        kind: z.literal('tracker-item'),
        provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        identifier: z.string().min(1),
        title: z.string(),
        url: z.string(),
    }),
    z.object({
        kind: z.literal('guest-issue'),
        providerId: z.string().min(1),
        id: z.string().min(1),
        title: z.string(),
        url: z.string(),
        data: z.json().optional(),
    }),
    z.object({
        kind: z.literal('guest-pr'),
        providerId: z.string().min(1),
        id: z.string().min(1),
        title: z.string(),
        url: z.string(),
        data: z.json().optional(),
    }),
    z.object({
        kind: z.literal('session'),
        sessionId: z.string().min(1),
        title: z.string(),
        messageId: z.string().min(1).optional(),
    }),
    z.object({
        kind: z.literal('session-message'),
        sessionId: z.string().min(1),
        messageId: z.string().min(1),
        sessionTitle: z.string(),
        excerpt: z.string(),
    }),
]);
const contextPayloadSchema = z.union([
    canonicalContextPayloadSchema,
    z.object({
        kind: z.literal('github-issue'),
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
    }).transform(({ number, title, url }): RepositoryIssueContext => ({ kind: 'repository-issue', number, title, url })),
    z.object({
        kind: z.literal('github-pr'),
        number: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
    }).transform(({ number, title, url }): ChangeRequestContext => ({ kind: 'change-request', provider: 'github', number, title, url })),
    z.object({
        kind: z.literal('linear-issue'),
        identifier: z.string().min(1),
        title: z.string(),
        url: z.string(),
    }).transform(({ identifier, title, url }): TrackerItemContext => ({ kind: 'tracker-item', provider: 'linear', identifier, title, url })),
]);

const openCodeCommentSchema = z.object({
    path: z.string(),
    selection: z.object({
        startLine: z.number().finite(),
        endLine: z.number().finite(),
        startChar: z.number().finite().optional(),
        endChar: z.number().finite().optional(),
    }).optional(),
    comment: z.string(),
    preview: z.string().optional(),
    origin: z.enum(['file', 'review']).optional(),
});

export const contextPartMetadataSchema = z.object({
    [CONTEXT_METADATA_KEY]: contextPayloadSchema,
    [OPENCODE_COMMENT_METADATA_KEY]: openCodeCommentSchema.optional(),
});

export type ContextCarrierPart = { type?: string; metadata?: Metadata };

export function readContextPart(part: ContextCarrierPart): ContextPartPayload | null {
    if (part.type !== undefined && part.type !== 'text') return null;
    const contextValue = part.metadata?.[CONTEXT_METADATA_KEY];
    const commentValue = part.metadata?.[OPENCODE_COMMENT_METADATA_KEY];
    if (contextValue === undefined && commentValue === undefined) return null;

    const parsed = contextPayloadSchema.safeParse(contextValue);
    if (parsed.success) return parsed.data;

    const compatible = openCodeCommentSchema.safeParse(commentValue);
    if (compatible.success) {
        const comment = compatible.data;
        if (!comment.selection) {
            return {
                kind: 'file-quote',
                fileLabel: comment.path,
                quote: comment.preview ?? '',
                text: comment.comment,
            };
        }
        return {
            kind: 'code-comment',
            source: comment.origin === 'review' ? 'diff' : 'file',
            fileLabel: comment.path,
            startLine: comment.selection.startLine,
            endLine: comment.selection.endLine,
            language: '',
            code: comment.preview ?? '',
            text: comment.comment,
        };
    }

    return null;
}

export function hasContextParts(parts: ContextCarrierPart[]): boolean {
    return parts.some((part) => readContextPart(part) !== null);
}

export function draftFromContextPayload(
    payload: ContextPartPayload,
): Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'> | null {
    switch (payload.kind) {
        case 'code-comment': {
            const draft: Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'> = {
                source: payload.source,
                fileLabel: payload.fileLabel,
                startLine: payload.startLine,
                endLine: payload.endLine,
                code: payload.code,
                language: payload.language,
                text: payload.text,
            };
            if (payload.changedCode !== undefined) draft.changedCode = payload.changedCode;
            if (payload.side) draft.side = payload.side;
            if (payload.origin) draft.origin = payload.origin;
            return draft;
        }
        case 'terminal':
            return {
                source: 'terminal',
                fileLabel: payload.terminalLabel,
                startLine: payload.startLine,
                endLine: payload.endLine,
                code: payload.output,
                language: '',
                text: '',
                terminalId: payload.terminalId,
            };
        case 'browser-annotation':
            return {
                source: 'preview-annotation',
                fileLabel: payload.pageUrl,
                startLine: 0,
                endLine: 0,
                code: payload.prompt,
                language: '',
                text: payload.text,
            };
        case 'pr-comment':
            return { source: 'pr-comment', fileLabel: payload.label, startLine: 0, endLine: 0, code: payload.body, language: '', text: payload.text, ...(payload.provider ? { provider: payload.provider } : {}) };
        case 'pr-check':
            return { source: 'pr-check', fileLabel: payload.label, startLine: 0, endLine: 0, code: payload.output, language: '', text: payload.text, ...(payload.provider ? { provider: payload.provider } : {}) };
        case 'file-quote':
            return {
                source: 'file-quote',
                fileLabel: payload.fileLabel,
                startLine: payload.startLine ?? 0,
                endLine: payload.endLine ?? 0,
                code: payload.quote,
                language: '',
                text: payload.text,
            };
        case 'chat-quote':
            return {
                source: 'chat-quote',
                fileLabel: payload.messageId ?? '',
                startLine: 0,
                endLine: 0,
                code: payload.quote,
                language: '',
                text: payload.text,
                anchor: payload.anchor,
            };
        case 'repository-issue':
        case 'repository-discussion':
        case 'change-request':
        case 'tracker-item':
        case 'guest-issue':
        case 'guest-pr':
        case 'session':
        case 'session-message':
        case 'shared-page':
            return null;
    }
}
