
import type { JsonValue } from '@openchamber/sdk';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { SourceControlProvider } from '@/lib/api/types';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { QueuedContextPart, QueuedMessage } from '@/stores/messageQueueStore';
import { withoutShareLinkKeys } from '@/lib/received-pages/link';
import { contextPayloadFromDraft, createContextPart, type ContextPartMetadata, type ContextPartPayload } from '@/lib/messages/contextParts';

export interface OutgoingPart {
    text: string;
    attachments?: AttachedFile[];
    synthetic?: boolean;
    metadata?: ContextPartMetadata;
}

export interface OutgoingMessage {
    primaryText: string;
    primaryAttachments: AttachedFile[];
    additionalParts: OutgoingPart[];
    agentMentionName?: string;
    skillNames: string[];
    isEmpty: boolean;
}

export interface QueuedInput {
    text: string;
    agentMention?: string;
    attachments?: AttachedFile[];
    context?: readonly QueuedContextPart[];
}

export const selectComposerQueue = (messages: readonly QueuedMessage[]): readonly QueuedMessage[] =>
    messages.some((message) => message.scheduledTask)
        ? messages.filter((message) => !message.scheduledTask)
        : messages;

export type ComposerContextReference =
    | { kind: 'repository-issue'; provider?: SourceControlProvider; number: number; title: string; url: string; contextText: string }
    | { kind: 'repository-discussion'; provider: SourceControlProvider; number: number; title: string; url: string; contextText: string }
    | { kind: 'change-request'; provider: SourceControlProvider; number: number; title: string; url: string; context: string }
    | { kind: 'tracker-item'; provider: string; identifier: string; title: string; url: string; contextText: string }
    | {
        kind: 'guest';
        providerId: string;
        id: string;
        title: string;
        url: string;
        contextText: string;
        thread?: 'issue' | 'pull';
        data?: JsonValue;
    }
    | { kind: 'session'; sessionId: string; title: string; contextText: string; messageId?: string }
    | { kind: 'session-message'; sessionId: string; messageId: string; sessionTitle: string; excerpt: string; contextText: string }
    | { kind: 'shared-page'; receivedId: string | null; host: string; title: string; opened: boolean; contextText: string };

export interface ComposerContextInput {
    inlineComments: readonly InlineCommentDraft[];
    syntheticTexts: readonly string[];
    references: readonly ComposerContextReference[];
}

export interface OutgoingMessageInput extends ComposerContextInput {
    queued: readonly QueuedInput[];
    composerText: string | null;
    composerAttachments: readonly AttachedFile[];
}

export interface OutgoingMessageDeps {
    parseAgentMention: (text: string) => { text: string; agentName?: string };
    extractFileMentions: (text: string) => { text: string; attachments: AttachedFile[] };
    sanitizeAttachments: (files: readonly AttachedFile[] | undefined) => AttachedFile[];
    collectSkillNames: (text: string) => string[];
}

export function buildOutgoingMessage(
    input: OutgoingMessageInput,
    deps: OutgoingMessageDeps,
): OutgoingMessage {
    // external: #4746 OpenCode delivers additional text parts as synthetic messages hidden by the timeline.
    const texts: string[] = [];
    const primaryAttachments: AttachedFile[] = [];
    let agentMentionName: string | undefined;
    const additionalParts: OutgoingPart[] = [];
    const addText = (text: string) => {
        if (text.trim()) texts.push(withoutShareLinkKeys(text));
    };

    const skillNames: string[] = [];
    const noteSkills = (text: string) => {
        for (const name of deps.collectSkillNames(text)) {
            if (!skillNames.includes(name)) skillNames.push(name);
        }
    };

    const noteAgent = (name?: string) => {
        if (!agentMentionName && name) agentMentionName = name;
    };

    const resolve = (raw: string) => {
        const agent = deps.parseAgentMention(raw);
        noteAgent(agent.agentName);
        const mentions = deps.extractFileMentions(agent.text);
        noteSkills(mentions.text);
        return mentions;
    };

    for (const queued of input.queued) {
        noteAgent(queued.agentMention);
        addText(queued.text);
        primaryAttachments.push(...deps.sanitizeAttachments(queued.attachments));
        additionalParts.push(...queuedContextToParts(queued.context ?? []));
    }

    if (input.composerText !== null) {
        const resolved = resolve(input.composerText.replace(/^\n+|\n+$/g, ''));
        addText(resolved.text);
        primaryAttachments.push(
            ...deps.sanitizeAttachments(input.composerAttachments),
            ...resolved.attachments,
        );
    }
    const primaryText = texts.join('\n\n');

    additionalParts.push(...queuedContextToParts(
        buildComposerContext(input, null),
    ));

    return {
        primaryText,
        primaryAttachments,
        additionalParts,
        agentMentionName,
        skillNames,
        isEmpty: !primaryText && primaryAttachments.length === 0 && additionalParts.length === 0,
    };
}

export function buildComposerContext(
    input: ComposerContextInput,
    skillInstruction: string | null,
): QueuedContextPart[] {
    const context: QueuedContextPart[] = [];
    const attach = (part: { text: string; metadata: ContextPartMetadata }) => {
        context.push({ kind: 'context', text: part.text, metadata: part.metadata });
    };

    for (const draft of input.inlineComments) {
        attach(createContextPart(contextPayloadFromDraft(draft)));
    }

    for (const text of input.syntheticTexts) {
        context.push({ kind: 'synthetic', text });
    }

    for (const reference of input.references) {
        switch (reference.kind) {
            case 'repository-issue': {
                const { provider, number, title, url, contextText } = reference;
                attach(createContextPart({ kind: 'repository-issue', ...(provider ? { provider } : {}), number, title, url }, contextText));
                break;
            }
            case 'repository-discussion': {
                const { provider, number, title, url, contextText } = reference;
                attach(createContextPart({ kind: 'repository-discussion', provider, number, title, url }, contextText));
                break;
            }
            case 'change-request': {
                const { provider, number, title, url, context: prContext } = reference;
                attach(createContextPart({ kind: 'change-request', provider, number, title, url }, prContext));
                break;
            }
            case 'tracker-item': {
                const { provider, identifier, title, url, contextText } = reference;
                attach(createContextPart({ kind: 'tracker-item', provider, identifier, title, url }, contextText));
                break;
            }
            case 'guest': {
                const { providerId, id, title, url, contextText, thread, data } = reference;
                const payload: Extract<ContextPartPayload, { kind: 'guest-issue' | 'guest-pr' }> = {
                    kind: thread === 'pull' ? 'guest-pr' : 'guest-issue',
                    providerId,
                    id,
                    title,
                    url,
                };
                if (data !== undefined) {
                    payload.data = data;
                }
                attach(createContextPart(payload, contextText));
                break;
            }
            case 'session': {
                const { sessionId, title, contextText, messageId } = reference;
                const payload: Extract<ContextPartPayload, { kind: 'session' }> = { kind: 'session', sessionId, title };
                if (messageId) payload.messageId = messageId;
                attach(createContextPart(payload, contextText));
                break;
            }
            case 'session-message': {
                const { sessionId, messageId, sessionTitle, excerpt, contextText } = reference;
                attach(createContextPart({ kind: 'session-message', sessionId, messageId, sessionTitle, excerpt }, contextText));
                break;
            }
            case 'shared-page': {
                const { receivedId, host, title, opened, contextText } = reference;
                attach(createContextPart({ kind: 'shared-page', receivedId, host, title, opened }, contextText));
                break;
            }
        }
    }

    if (skillInstruction) {
        context.push({ kind: 'instruction', text: skillInstruction });
    }

    return context;
}

export function queuedContextToParts(context: readonly QueuedContextPart[]): OutgoingPart[] {
    const parts: OutgoingPart[] = [];
    for (const part of context) {
        if (part.kind !== 'context') {
            parts.push({ text: part.text, synthetic: true });
            continue;
        }
        if (part.instructions) parts.push({ text: part.instructions, synthetic: true });
        parts.push({ text: part.text, synthetic: true, metadata: part.metadata });
    }
    return parts;
}

export async function expandCommentSnippets(
    drafts: readonly InlineCommentDraft[],
    expandText: (text: string) => Promise<string>,
): Promise<InlineCommentDraft[]> {
    return Promise.all(drafts.map(async (draft) => {
        if (!draft.text) return draft;
        const text = await expandText(draft.text).catch(() => draft.text);
        return text === draft.text ? draft : { ...draft, text };
    }));
}
