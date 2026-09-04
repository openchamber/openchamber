/**
 * Assembling what the composer actually sends.
 *
 * A single send can carry more than what the user just typed: messages queued
 * while the previous turn ran, inline review comments, `@file` references
 * resolved to attachments, a linked GitHub issue or PR, synthetic parts from
 * conflict resolution, and an instruction naming the skills mentioned inline.
 *
 * OpenCode takes one primary message plus additional parts, so all of that has
 * to be flattened into that shape — and the flattening has rules that are easy
 * to get wrong and impossible to see when they are spread through a 400-line
 * handler. They are stated here, as a pure function over injected resolvers,
 * so the ordering can be tested rather than trusted.
 */

import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { QueuedContextPart } from '@/stores/messageQueueStore';
import { contextPayloadFromDraft, createContextPart, type ContextPartMetadata } from '@/lib/messages/contextParts';

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

/** What the composer has attached besides text and files. */
export interface ComposerContextInput {
    /** Context drafts (code comments, terminal selections, annotations, PR context). */
    inlineComments: readonly InlineCommentDraft[];
    /** Synthetic context produced elsewhere (conflict resolution, and such). */
    syntheticTexts: readonly string[];
    linkedIssue: { number: number; title: string; url: string; contextText: string } | null;
    linkedPr: { number: number; title: string; url: string; instructions: string; context: string } | null;
    linkedLinearIssue: { identifier: string; title: string; url: string; contextText: string } | null;
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
    /** Skills named inline with `/name`. */
    collectSkillNames: (text: string) => string[];
    /** Instruction telling the model which skills the user named. */
    buildSkillInstruction: (names: string[]) => string | null;
}

export function buildOutgoingMessage(
    input: OutgoingMessageInput,
    deps: OutgoingMessageDeps,
): OutgoingMessage {
    let primaryText = '';
    let primaryAttachments: AttachedFile[] = [];
    let agentMentionName: string | undefined;
    const additionalParts: OutgoingPart[] = [];

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

    // Queued messages come first, in the order they were queued: the oldest
    // becomes the primary message so the turn reads chronologically. Each one
    // is followed by the context it was queued with.
    input.queued.forEach((queued, index) => {
        noteAgent(queued.agentMention);
        const attachments = deps.sanitizeAttachments(queued.attachments);

        if (index === 0) {
            primaryText = queued.text;
            primaryAttachments = attachments;
        } else {
            additionalParts.push({ text: queued.text, attachments });
        }
        additionalParts.push(...queuedContextToParts(queued.context ?? []));
    });

    // The composer's own text follows, becoming primary only when nothing was
    // queued ahead of it.
    if (input.composerText !== null) {
        const resolved = resolve(input.composerText.replace(/^\n+|\n+$/g, ''));
        const attachments = [
            ...deps.sanitizeAttachments(input.composerAttachments),
            ...resolved.attachments,
        ];

        if (input.queued.length === 0) {
            primaryText = resolved.text;
            primaryAttachments = attachments;
        } else {
            additionalParts.push({ text: resolved.text, attachments });
        }
    }

    // Everything the composer had attached follows its text.
    additionalParts.push(...queuedContextToParts(
        buildComposerContext(input, deps.buildSkillInstruction(skillNames)),
    ));

    return {
        primaryText,
        primaryAttachments,
        additionalParts,
        agentMentionName,
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
    const attach = (part: { text: string; metadata: ContextPartMetadata }, instructions?: string) => {
        const entry: QueuedContextPart = { kind: 'context', text: part.text, metadata: part.metadata };
        if (instructions) entry.instructions = instructions;
        context.push(entry);
    };

    for (const draft of input.inlineComments) {
        attach(createContextPart(contextPayloadFromDraft(draft)));
    }

    for (const text of input.syntheticTexts) {
        context.push({ kind: 'synthetic', text });
    }

    if (input.linkedIssue) {
        const { number, title, url, contextText } = input.linkedIssue;
        attach(createContextPart({ kind: 'github-issue', number, title, url }, contextText));
    }

    if (input.linkedPr) {
        // Instructions before context: the model is told how to read the diff
        // before it is given the diff.
        const { number, title, url, instructions, context: prContext } = input.linkedPr;
        attach(createContextPart({ kind: 'github-pr', number, title, url }, prContext), instructions);
    }

    if (input.linkedLinearIssue) {
        const { identifier, title, url, contextText } = input.linkedLinearIssue;
        attach(createContextPart({ kind: 'linear-issue', identifier, title, url }, contextText));
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
