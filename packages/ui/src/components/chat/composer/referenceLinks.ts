
import type { ReferenceLinkTarget } from '@/components/references/resolveComposerReferences';
import { referenceLinkChip as presentReferenceLinkChip } from '@/lib/messages/referenceLinkChip';
import type { RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import type { TrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';

import { composerReferenceKey, withReferenceSourceLinks, type ComposerReference } from './composerReferences';

const WEB_LINK = /https?:\/\/[^\s<>()"'`]+/gi;

type WebLinkRange = { start: number; end: number; link: string };

export const findWebLinks = (text: string): WebLinkRange[] => {
    if (!text.includes('http')) return [];
    const found: WebLinkRange[] = [];
    for (const match of text.matchAll(WEB_LINK)) {
        const link = match[0].replace(/[.,;:!?*_~]+$/, '');
        found.push({ start: match.index, end: match.index + link.length, link });
    }
    return found;
};

const referenceLinkTarget = (link: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): ReferenceLinkTarget | null => {
    const tracked = trackerUrls(link);
    if (tracked) return { source: 'tracker', provider: tracked.provider, identifier: tracked.identifier };
    const resolver = urls.resolverFor?.(link);
    if (resolver) return { source: 'repository-url', ...resolver };
    const item = urls.match(link);
    if (!item || item.kind === 'discussion') return null;
    return { source: 'repository', provider: item.provider, instance: item.instance, owner: item.owner, repo: item.repo, kind: item.kind, number: item.number };
};

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

export const referenceLinksInText = (text: string, read: ReadonlyMap<string, ComposerReference>): ComposerReference[] => {
    if (read.size === 0) return [];
    const references = new Map<string, ComposerReference>();
    for (const { link } of findWebLinks(text)) {
        const reference = read.get(link);
        if (!reference) continue;
        const key = composerReferenceKey(reference);
        references.set(key, withReferenceSourceLinks(references.get(key) ?? reference, [link]));
    }
    return [...references.values()];
};

export const withReferencesFromText = (
    chips: readonly ComposerReference[],
    fromText: readonly ComposerReference[],
): ComposerReference[] => {
    const chipKeys = new Set(chips.map(composerReferenceKey));
    const textByKey = new Map(fromText.map((reference) => [composerReferenceKey(reference), reference]));
    return [
        ...chips.map((reference) => {
            const linked = textByKey.get(composerReferenceKey(reference));
            return linked ? withReferenceSourceLinks(reference, referenceTextLinks(linked)) : reference;
        }),
        ...fromText.filter((reference) => !chipKeys.has(composerReferenceKey(reference))),
    ];
};

export const referenceLinkChip = (reference: ComposerReference, urls: RepositoryUrlMatcher) => {
    if (reference.kind === 'shared-page') {
        const title = reference.title ?? reference.host;
        return { label: title, title, iconHref: '#oc-pages' };
    }
    const { label, title, icon } = presentReferenceLinkChip(reference, urls.descriptorOf);
    return reference.kind === 'change-request'
        ? { label, title, iconHref: `#oc-${icon}`, openUrl: reference.url }
        : { label, title, iconHref: `#oc-${icon}` };
};

export const referenceTextLink = (reference: ComposerReference): string => {
    if (reference.kind !== 'shared-page') return reference.url;
    return reference.link ?? `https://${reference.host}/p/${reference.receivedId ?? reference.shareKey.slice(reference.shareKey.lastIndexOf('/') + 1)}`;
};

export const referenceTextLinks = (reference: ComposerReference): string[] => [
    referenceTextLink(reference),
    ...(reference.kind === 'change-request' ? reference.sourceLinks ?? [] : []),
];

export const withoutReferenceSourceLinks = (
    references: readonly ComposerReference[],
    links: ReadonlySet<string>,
    text: string,
): readonly ComposerReference[] => {
    let changed = false;
    const next = references.flatMap((reference) => {
        if (reference.kind !== 'change-request' || !reference.sourceLinks?.some((link) => links.has(link))) return [reference];
        changed = true;
        const sourceLinks = reference.sourceLinks.filter((link) => !links.has(link));
        const updated: ComposerReference = { ...reference, sourceLinks };
        if (sourceLinks.length === 0) delete updated.sourceLinks;
        return referencesLinkedIn(text, [updated]).length > 0 ? [updated] : [];
    });
    return changed ? next : references;
};

export const referencesLinkedIn = (text: string, references: readonly ComposerReference[]): ComposerReference[] => {
    if (references.length === 0) return [];
    const links = new Set(findWebLinks(text).map(({ link }) => link));
    return references.filter((reference) => referenceTextLinks(reference).some((link) => links.has(link)));
};

export const withMissingReferenceLinks = (text: string, references: readonly ComposerReference[]): string => {
    const links = new Set(findWebLinks(text).map(({ link }) => link));
    const missing = Array.from(new Set(references
        .filter((reference) => !referenceTextLinks(reference).some((link) => links.has(link)))
        .map(referenceTextLink)));
    if (missing.length === 0) return text;
    const head = text.replace(/\s+$/, '');
    return head ? `${head} ${missing.join(' ')}` : missing.join(' ');
};

export const withoutSharedPageLinks = (text: string, references: readonly ComposerReference[]): string => {
    const links = new Set(references.filter((reference) => reference.kind === 'shared-page').map(referenceTextLink));
    if (links.size === 0) return text;
    const ranges = findWebLinks(text).filter((range) => links.has(range.link));
    let result = text;
    for (const range of ranges.reverse()) {
        const before = result.slice(0, range.start).replace(/[ \t]+$/, '');
        const after = result.slice(range.end).replace(/^[ \t]+/, '');
        result = before && after && !/\n$/.test(before) && !/^\n/.test(after) ? `${before} ${after}` : `${before}${after}`;
    }
    return result.trim() ? result : '';
};
