/**
 * Links to issues, change requests and tracker items written in the composer
 * text. A pasted one is read like an item chosen in the picker, draws as a
 * chip where it stands, and goes with the message as that item's context;
 * one deleted from the text is not sent.
 */

import type { ReferenceLinkTarget } from '@/components/references/resolveComposerReferences';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import type { RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import type { TrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { trackerPresentation } from '@/lib/trackers/presentation';

import { composerReferenceKey, type ComposerReference } from './composerReferences';

// A web address as it sits in text; punctuation that ends the sentence is not part of it.
const WEB_LINK = /https?:\/\/[^\s<>()"'`]+/gi;

type WebLinkRange = { start: number; end: number; link: string };

export const findWebLinks = (text: string): WebLinkRange[] => {
    if (!text.includes('http')) return [];
    const found: WebLinkRange[] = [];
    for (const match of text.matchAll(WEB_LINK)) {
        const link = match[0].replace(/[.,;:!?]+$/, '');
        found.push({ start: match.index, end: match.index + link.length, link });
    }
    return found;
};

/** What a link names: a served tracker's item first, then an issue or change request. Discussions stay text. */
const referenceLinkTarget = (link: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): ReferenceLinkTarget | null => {
    const tracked = trackerUrls(link);
    if (tracked) return { source: 'tracker', provider: tracked.provider, identifier: tracked.identifier };
    const item = urls.match(link);
    if (!item || item.kind === 'discussion') return null;
    return { source: 'repository', provider: item.provider, instance: item.instance, owner: item.owner, repo: item.repo, kind: item.kind, number: item.number };
};

/** Every link in text that names an item, once each, in order. */
export const findReferenceLinks = (
    text: string,
    urls: RepositoryUrlMatcher,
    trackerUrls: TrackerUrlMatcher,
): Array<{ link: string; target: ReferenceLinkTarget }> => {
    const seen = new Set<string>();
    return findWebLinks(text).flatMap(({ link }) => {
        if (seen.has(link)) return [];
        seen.add(link);
        const target = referenceLinkTarget(link, urls, trackerUrls);
        return target ? [{ link, target }] : [];
    });
};

/** The items the text links, by the links read so far, once each, in order. */
export const referenceLinksInText = (text: string, read: ReadonlyMap<string, ComposerReference>): ComposerReference[] => {
    if (read.size === 0) return [];
    const references = new Map<string, ComposerReference>();
    for (const { link } of findWebLinks(text)) {
        const reference = read.get(link);
        if (reference && !references.has(composerReferenceKey(reference))) references.set(composerReferenceKey(reference), reference);
    }
    return [...references.values()];
};

/** The picker's chips, then the items the text links that no chip carries: a chip keeps what the picker set on it, such as the diff. */
export const withReferencesFromText = (
    chips: readonly ComposerReference[],
    fromText: readonly ComposerReference[],
): ComposerReference[] => {
    const chipKeys = new Set(chips.map(composerReferenceKey));
    return [...chips, ...fromText.filter((reference) => !chipKeys.has(composerReferenceKey(reference)))];
};

const CHIP_TITLE_LENGTH = 48;

/** How a read link draws in the text: its number and title, with its kind's mark. */
export const referenceLinkChip = (reference: ComposerReference, urls: RepositoryUrlMatcher) => {
    const number = (() => {
        switch (reference.kind) {
            case 'tracker-item': return reference.identifier;
            case 'change-request': return formatChangeRequestReference(urls.descriptorOf(reference.provider), reference.number);
            case 'repository-issue':
            case 'repository-discussion': return `${urls.descriptorOf(reference.provider ?? 'github').terminology.issuePrefix}${reference.number}`;
            case 'guest': return reference.id;
        }
    })();
    const icon = reference.kind === 'tracker-item'
        ? trackerPresentation(reference.provider).icon
        : reference.kind === 'change-request' ? 'git-pull-request' : 'record-circle';
    const title = reference.title.length > CHIP_TITLE_LENGTH
        ? `${reference.title.slice(0, CHIP_TITLE_LENGTH - 1).trimEnd()}…`
        : reference.title;
    return { label: `${number} ${title}`, title: `${number} ${reference.title}`, iconHref: `#oc-${icon}` };
};
