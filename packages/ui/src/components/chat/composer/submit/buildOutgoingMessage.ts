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

export interface OutgoingPart {
    text: string;
    attachments?: AttachedFile[];
    /** Synthetic parts are context for the model, not shown as user content. */
    synthetic?: boolean;
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

export interface QueuedInput {
    content: string;
    attachments?: AttachedFile[];
}

export interface OutgoingMessageInput {
    /** Messages queued while a turn was running, oldest first. */
    queued: readonly QueuedInput[];
    /** The composer's own text, or null when this send skips it. */
    composerText: string | null;
    composerAttachments: readonly AttachedFile[];
    /** Inline review comments, appended to the user's last authored text. */
    inlineComments: readonly unknown[];
    /** Synthetic context produced elsewhere (conflict resolution, and such). */
    syntheticTexts: readonly string[];
    linkedIssueContext: string | null;
    linkedPr: { instructions: string; context: string } | null;
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
    /** Append inline review comments to a message body. */
    appendComments: (text: string, comments: readonly unknown[]) => string;
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
    // becomes the primary message so the turn reads chronologically.
    input.queued.forEach((queued, index) => {
        const resolved = resolve(queued.content);
        const attachments = [
            ...deps.sanitizeAttachments(queued.attachments),
            ...resolved.attachments,
        ];

        if (index === 0) {
            primaryText = resolved.text;
            primaryAttachments = attachments;
            return;
        }
        additionalParts.push({ text: resolved.text, attachments });
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

    // Inline comments attach to the last thing the user authored, so they read
    // as a continuation of it rather than as a separate turn.
    if (input.inlineComments.length > 0) {
        const lastAuthored = input.queued.length > 0 && additionalParts.length > 0
            ? additionalParts[additionalParts.length - 1]
            : null;
        if (lastAuthored) {
            lastAuthored.text = deps.appendComments(lastAuthored.text, input.inlineComments);
        } else {
            primaryText = deps.appendComments(primaryText, input.inlineComments);
        }
    }

    // Everything below is context for the model, never user-visible content.
    for (const text of input.syntheticTexts) {
        additionalParts.push({ text, synthetic: true });
    }

    if (input.linkedIssueContext) {
        additionalParts.push({ text: input.linkedIssueContext, synthetic: true });
    }

    if (input.linkedPr) {
        // Instructions before context: the model is told how to read the diff
        // before it is given the diff.
        additionalParts.push({ text: input.linkedPr.instructions, synthetic: true });
        additionalParts.push({ text: input.linkedPr.context, synthetic: true });
    }

    const skillInstruction = deps.buildSkillInstruction(skillNames);
    if (skillInstruction) {
        additionalParts.push({ text: skillInstruction, synthetic: true });
    }

    return {
        primaryText,
        primaryAttachments,
        additionalParts,
        agentMentionName,
        isEmpty: !primaryText && primaryAttachments.length === 0 && additionalParts.length === 0,
    };
}
