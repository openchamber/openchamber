/**
 * Assembling what the composer actually sends.
 *
 * A single send can carry more than what the user just typed: messages queued
 * while the previous turn ran, inline review comments, `@file` references
 * resolved to attachments, linked issues and PRs, synthetic parts from
 * conflict resolution, and the skills mentioned inline.
 *
 * OpenCode takes one primary message plus additional parts, so all of that has
 * to be flattened into that shape — and the flattening has rules that are easy
 * to get wrong and impossible to see when they are spread through a 400-line
 * handler. They are stated here, as a pure function over injected resolvers,
 * so the ordering can be tested rather than trusted.
 */

import type { JsonValue } from '@openchamber/sdk';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { SourceControlProvider } from '@/lib/api/types';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { QueuedContextPart, QueuedMessage } from '@/stores/messageQueueStore';
import { contextPayloadFromDraft, createContextPart, type ContextPartMetadata, type ContextPartPayload } from '@/lib/messages/contextParts';

export interface OutgoingPart {
    text: string;
    attachments?: AttachedFile[];
    /** Synthetic parts are context for the model, not shown as user content. */
    synthetic?: boolean;
    /** Structured context (see contextParts.ts), persisted with the part. */
    metadata?: ContextPartMetadata;
}

export interface OutgoingMessage {
    primaryText: string;
    primaryAttachments: AttachedFile[];
    additionalParts: OutgoingPart[];
    /** The agent the first `@agent` mention routed to, if any. */
    agentMentionName?: string;
    /**
     * Skills the composer text names inline, deduped in order of appearance.
     * The send attaches them to the prompt (see `SkillMentions`); queued
     * messages already carry the instruction they were queued with.
     */
    skillNames: string[];
    /** True when there is nothing worth sending. */
    isEmpty: boolean;
}

/**
 * A queued message is already resolved: its agent mention was stripped, its
 * file mentions became attachments, and the context the composer had attached
 * travels with it. Assembly only places it.
 */
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

/** An issue, PR or tracker item attached to the composer, as it is sent. */
export type ComposerContextReference =
    | { kind: 'repository-issue'; provider?: SourceControlProvider; number: number; title: string; url: string; contextText: string }
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
        /** Opaque guest payload; rides the context part metadata, not its text. */
        data?: JsonValue;
    };

/** What the composer has attached besides text and files. */
export interface ComposerContextInput {
    /** Context drafts (code comments, terminal selections, annotations, PR context). */
    inlineComments: readonly InlineCommentDraft[];
    /** Synthetic context produced elsewhere (conflict resolution, and such). */
    syntheticTexts: readonly string[];
    /** Attached issues, PRs and tracker items, in the order they were attached. */
    references: readonly ComposerContextReference[];
}

export interface OutgoingMessageInput extends ComposerContextInput {
    /** Messages queued while a turn was running, oldest first. */
    queued: readonly QueuedInput[];
    /** The composer's own text, or null when this send skips it. */
    composerText: string | null;
    composerAttachments: readonly AttachedFile[];
}

/**
 * The parts of assembly that depend on stores or async config, injected so the
 * assembly itself stays pure.
 */
export interface OutgoingMessageDeps {
    /** Strip a leading `@agent` mention and report which agent it named. */
    parseAgentMention: (text: string) => { text: string; agentName?: string };
    /** Resolve `@path` references into server-side attachments. */
    extractFileMentions: (text: string) => { text: string; attachments: AttachedFile[] };
    /** Normalize attachments for transport (server paths become file URLs). */
    sanitizeAttachments: (files: readonly AttachedFile[] | undefined) => AttachedFile[];
    /** Skills named with `$name`. */
    collectSkillNames: (text: string) => string[];
}

export function buildOutgoingMessage(
    input: OutgoingMessageInput,
    deps: OutgoingMessageDeps,
): OutgoingMessage {
    // Everything the user typed shares the one visible message. OpenCode 2.x
    // takes a single prompt text and delivers every additional part as a
    // synthetic message the timeline does not show (#4746).
    const texts: string[] = [];
    const primaryAttachments: AttachedFile[] = [];
    let agentMentionName: string | undefined;
    const additionalParts: OutgoingPart[] = [];
    const addText = (text: string) => {
        if (text.trim()) texts.push(text);
    };

    const skillNames: string[] = [];
    const noteSkills = (text: string) => {
        for (const name of deps.collectSkillNames(text)) {
            if (!skillNames.includes(name)) skillNames.push(name);
        }
    };

    /** The first agent mention encountered wins; later ones are ignored. */
    const noteAgent = (name?: string) => {
        if (!agentMentionName && name) agentMentionName = name;
    };

    /** Run a body through mention parsing, collecting its side effects. */
    const resolve = (raw: string) => {
        const agent = deps.parseAgentMention(raw);
        noteAgent(agent.agentName);
        const mentions = deps.extractFileMentions(agent.text);
        noteSkills(mentions.text);
        return mentions;
    };

    // Queued messages come first, in the order they were queued, so the turn
    // reads chronologically. The context each was queued with follows it.
    for (const queued of input.queued) {
        noteAgent(queued.agentMention);
        addText(queued.text);
        primaryAttachments.push(...deps.sanitizeAttachments(queued.attachments));
        additionalParts.push(...queuedContextToParts(queued.context ?? []));
    }

    // The composer's own text follows everything queued.
    if (input.composerText !== null) {
        const resolved = resolve(input.composerText.replace(/^\n+|\n+$/g, ''));
        addText(resolved.text);
        primaryAttachments.push(
            ...deps.sanitizeAttachments(input.composerAttachments),
            ...resolved.attachments,
        );
    }
    const primaryText = texts.join('\n\n');

    // Everything the composer had attached follows its text.
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

/**
 * Everything the composer has attached besides text and files, in send
 * order. Each attached context item becomes its own synthetic part carrying
 * structured metadata, so the timeline can render it as a context block after
 * the server echoes the message back. Used both when sending and when queueing:
 * a queued message takes this context with it, so whoever delivers it later
 * sends exactly what the composer would have.
 */
export function buildComposerContext(
    input: ComposerContextInput,
    skillInstruction: string | null,
): QueuedContextPart[] {
    const context: QueuedContextPart[] = [];
    // An attached item is context only: no instructions guess what the user
    // wants from it; their message says that.
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
        }
    }

    if (skillInstruction) {
        context.push({ kind: 'instruction', text: skillInstruction });
    }

    return context;
}

/** The synthetic parts a captured context is delivered as, in order. */
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

/**
 * Expand `#snippet` references in the words of each attached comment, before
 * the comments become synthetic context. Only `text` expands: the quoted code
 * or message the comment points at is the user's evidence and stays verbatim.
 * A comment whose expansion fails is sent as written.
 */
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
