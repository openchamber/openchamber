/**
 * Issues, pull requests and tracker tickets attached to the composer.
 *
 * A message may carry any number of them, from any source: GitHub issues and
 * PRs, Linear issues, and items extensions hand over through `attach`. Each
 * one becomes its own context part on send, in the order it was attached.
 * Attaching an item that is already on the composer replaces it in place,
 * so reopening the picker to toggle a PR's diff never duplicates the chip.
 */

import type { JsonValue } from '@openchamber/sdk';

import { buildLinkedGuestIssue, buildLinkedIssue, buildLinkedLinearIssue, type LinkedIssue } from '@/lib/linkedIssues';

import type { ComposerContextReference } from './submit/buildOutgoingMessage';

export type ComposerReferenceAuthor = { login: string; avatarUrl?: string };

export type ComposerReference =
    | {
        kind: 'github-issue';
        number: number;
        title: string;
        url: string;
        contextText: string;
        author?: ComposerReferenceAuthor;
    }
    | {
        kind: 'github-pr';
        number: number;
        title: string;
        url: string;
        /** Empty when restored from a queued message: branches were not captured. */
        head: string;
        base: string;
        includeDiff: boolean;
        instructionsText: string;
        contextText: string;
        author?: ComposerReferenceAuthor;
    }
    | {
        kind: 'linear-issue';
        identifier: string;
        title: string;
        url: string;
        contextText: string;
        author?: ComposerReferenceAuthor;
    }
    | {
        kind: 'guest';
        providerId: string;
        id: string;
        title: string;
        url: string;
        contextText: string;
        thread: 'issue' | 'pull';
        author?: string;
        head?: string;
        base?: string;
        /** Opaque guest payload from `attach`; handed back on chip click, never shown. */
        data?: JsonValue;
    };

/** One key per item, whichever way it reached the composer. */
export const composerReferenceKey = (reference: ComposerReference): string => {
    switch (reference.kind) {
        case 'github-issue':
        case 'github-pr':
            return `github:${reference.url.toLowerCase()}`;
        case 'linear-issue':
            return `linear:${reference.identifier.toUpperCase()}`;
        case 'guest':
            return `guest:${reference.providerId}:${reference.id}`;
    }
};

/** Append new items; an item already attached is replaced where it stands. */
export const withComposerReferences = (
    current: readonly ComposerReference[],
    added: readonly ComposerReference[],
): ComposerReference[] => {
    const next = [...current];
    for (const reference of added) {
        const key = composerReferenceKey(reference);
        const index = next.findIndex((entry) => composerReferenceKey(entry) === key);
        if (index === -1) {
            next.push(reference);
        } else {
            next[index] = reference;
        }
    }
    return next;
};

export const withoutComposerReference = (current: readonly ComposerReference[], key: string): ComposerReference[] =>
    current.filter((entry) => composerReferenceKey(entry) !== key);

/** The session snapshot a sent reference leaves behind (see `linkedIssues.ts`). */
export const toLinkedIssue = (reference: ComposerReference, linkedAt: number): LinkedIssue => {
    switch (reference.kind) {
        case 'github-issue':
        case 'github-pr':
            return buildLinkedIssue({
                url: reference.url,
                number: reference.number,
                title: reference.title,
                kind: reference.kind === 'github-pr' ? 'pull' : 'issue',
                author: reference.author,
                linkedAt,
            });
        case 'linear-issue':
            return buildLinkedLinearIssue({
                identifier: reference.identifier,
                title: reference.title,
                url: reference.url,
                author: reference.author,
                linkedAt,
            });
        case 'guest':
            return buildLinkedGuestIssue({
                providerId: reference.providerId,
                identifier: reference.id,
                title: reference.title,
                url: reference.url,
                thread: reference.thread,
                author: reference.author,
                head: reference.head,
                base: reference.base,
                data: reference.data,
                linkedAt,
            });
    }
};

/** What the submission builder needs from a reference: text and identity, not chip details. */
export const toContextReference = (reference: ComposerReference): ComposerContextReference => {
    switch (reference.kind) {
        case 'github-issue':
            return { kind: 'github-issue', number: reference.number, title: reference.title, url: reference.url, contextText: reference.contextText };
        case 'github-pr':
            return {
                kind: 'github-pr',
                number: reference.number,
                title: reference.title,
                url: reference.url,
                instructions: reference.instructionsText,
                context: reference.contextText,
            };
        case 'linear-issue':
            return { kind: 'linear-issue', identifier: reference.identifier, title: reference.title, url: reference.url, contextText: reference.contextText };
        case 'guest': {
            const entry: Extract<ComposerContextReference, { kind: 'guest' }> = {
                kind: 'guest',
                providerId: reference.providerId,
                id: reference.id,
                title: reference.title,
                url: reference.url,
                contextText: reference.contextText,
                thread: reference.thread,
            };
            if (reference.data !== undefined) entry.data = reference.data;
            return entry;
        }
    }
};
