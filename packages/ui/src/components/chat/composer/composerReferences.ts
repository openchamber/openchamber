
import type { JsonValue } from '@openchamber/sdk';

import type { SourceControlProvider } from '@/lib/api/types';

import { buildLinkedDiscussion, buildLinkedGuestIssue, buildLinkedIssue, buildLinkedTrackerItem, type LinkedIssue } from '@/lib/linkedIssues';

import type { ComposerContextReference } from './submit/buildOutgoingMessage';

export type ComposerReferenceAuthor = { login: string; avatarUrl?: string };

export type ComposerReference =
    | {
        kind: 'shared-page';
        shareKey: string;
        receivedId: string | null;
        host: string;
        title: string | null;
        opened: boolean;
        contextText: string;
        link?: string;
    }
    | {
        kind: 'repository-issue';
        provider?: SourceControlProvider;
        number: number;
        title: string;
        url: string;
        contextText: string;
        author?: ComposerReferenceAuthor;
    }
    | {
        kind: 'repository-discussion';
        provider: SourceControlProvider;
        number: number;
        title: string;
        url: string;
        contextText: string;
        author?: ComposerReferenceAuthor;
    }
    | {
        kind: 'change-request';
        provider: SourceControlProvider;
        number: number;
        title: string;
        url: string;
        head: string;
        base: string;
        includeDiff: boolean;
        contextText: string;
        author?: ComposerReferenceAuthor;
    }
    | {
        kind: 'tracker-item';
        provider: string;
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
        data?: JsonValue;
    };

export const composerReferenceKey = (reference: ComposerReference): string => {
    switch (reference.kind) {
        case 'repository-issue':
        case 'repository-discussion':
        case 'change-request':
            return `repository:${reference.url.toLowerCase()}`;
        case 'tracker-item':
            return `${reference.provider}:${reference.identifier.toUpperCase()}`;
        case 'guest':
            return `guest:${reference.providerId}:${reference.id}`;
        case 'shared-page':
            return `shared-page:${reference.shareKey}`;
    }
};

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

export const toLinkedIssue = (reference: ComposerReference, linkedAt: number): LinkedIssue | null => {
    switch (reference.kind) {
        case 'shared-page':
            return null;
        case 'repository-issue':
        case 'change-request':
            return buildLinkedIssue({
                url: reference.url,
                number: reference.number,
                title: reference.title,
                kind: reference.kind === 'change-request' ? 'pull' : 'issue',
                author: reference.author,
                linkedAt,
            });
        case 'repository-discussion':
            return buildLinkedDiscussion({ url: reference.url, number: reference.number, title: reference.title, linkedAt });
        case 'tracker-item':
            return buildLinkedTrackerItem({
                provider: reference.provider,
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

export const toContextReference = (reference: ComposerReference): ComposerContextReference => {
    switch (reference.kind) {
        case 'shared-page':
            return {
                kind: 'shared-page',
                receivedId: reference.receivedId,
                host: reference.host,
                title: reference.title ?? '',
                opened: reference.opened,
                contextText: reference.contextText,
            };
        case 'repository-issue':
            return {
                kind: 'repository-issue',
                ...(reference.provider ? { provider: reference.provider } : {}),
                number: reference.number,
                title: reference.title,
                url: reference.url,
                contextText: reference.contextText,
            };
        case 'repository-discussion':
            return {
                kind: 'repository-discussion',
                provider: reference.provider,
                number: reference.number,
                title: reference.title,
                url: reference.url,
                contextText: reference.contextText,
            };
        case 'change-request':
            return {
                kind: 'change-request',
                provider: reference.provider,
                number: reference.number,
                title: reference.title,
                url: reference.url,
                context: reference.contextText,
            };
        case 'tracker-item':
            return {
                kind: 'tracker-item',
                provider: reference.provider,
                identifier: reference.identifier,
                title: reference.title,
                url: reference.url,
                contextText: reference.contextText,
            };
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
