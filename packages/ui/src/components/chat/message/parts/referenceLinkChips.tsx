import React from 'react';

import { isSameRepositoryItemLink } from '@/components/sourceBoard/openTrackerItem';
import type { Part } from '@/lib/opencode/model';
import { referenceLinkChip, type ReferenceLinkChip } from '@/lib/messages/referenceLinkChip';
import { useRepositoryUrlMatcher, type RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useTrackerUrlMatcher, type TrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { findWebLinks } from '../../composer/referenceLinks';
import { linkedItemOfDisplayPart, type InlineLinkedItem } from '../normalizeUserDisplayParts';
import type { InlineTextNode } from './attachmentCitationChips';
import { ReferenceLinkChipButton } from './ReferenceLinkChipButton';

type InlineReferenceLink = { chip: ReferenceLinkChip; url: string; part: Part };

export type ReferenceLinkChips = ReadonlyMap<string, InlineReferenceLink>;

const NO_CHIPS: ReferenceLinkChips = new Map();

const withoutCode = (text: string): string => text
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/^(?: {4}|\t).*$/gm, ' ')
    .replace(/(`+)[\s\S]*?\1/g, ' ');

const namesItem = (link: string, item: InlineLinkedItem, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): boolean => {
    const tracked = trackerUrls(link);
    if (tracked) {
        return item.kind === 'tracker-item'
            && item.provider === tracked.provider
            && item.identifier.toUpperCase() === tracked.identifier.toUpperCase();
    }
    return item.kind !== 'tracker-item' && isSameRepositoryItemLink(link, item.url, urls);
};

export function referenceLinkChipsOf(
    texts: readonly string[],
    parts: readonly Part[],
    urls: RepositoryUrlMatcher,
    trackerUrls: TrackerUrlMatcher,
): ReferenceLinkChips {
    const items = parts.flatMap((part) => {
        const item = linkedItemOfDisplayPart(part);
        return item ? [{ item, part }] : [];
    });
    if (items.length === 0) return NO_CHIPS;
    let chips: Map<string, InlineReferenceLink> | null = null;
    for (const text of texts) {
        for (const { link } of findWebLinks(withoutCode(text))) {
            if (chips?.has(link)) continue;
            const linked = items.find(({ item }) => namesItem(link, item, urls, trackerUrls));
            if (!linked) continue;
            chips ??= new Map();
            chips.set(link, { chip: referenceLinkChip(linked.item, urls.descriptorOf), url: linked.item.url, part: linked.part });
        }
    }
    return chips ?? NO_CHIPS;
}

export function useReferenceLinkChips(texts: readonly string[], parts: readonly Part[]): ReferenceLinkChips {
    const urls = useRepositoryUrlMatcher();
    const trackerUrls = useTrackerUrlMatcher();
    return React.useMemo(() => referenceLinkChipsOf(texts, parts, urls, trackerUrls), [parts, texts, trackerUrls, urls]);
}

export const ReferenceLinkChipsContext = React.createContext<ReferenceLinkChips>(NO_CHIPS);

export function withReferenceLinkChips(text: string, chips: ReferenceLinkChips, keyPrefix: string): InlineTextNode[] {
    if (chips.size === 0) return [text];
    const nodes: InlineTextNode[] = [];
    let cursor = 0;
    for (const range of findWebLinks(text)) {
        const linked = chips.get(range.link);
        if (!linked) continue;
        if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
        nodes.push(<ReferenceLinkChipButton key={`${keyPrefix}-${range.start}`} chip={linked.chip} url={linked.url} />);
        cursor = range.end;
    }
    if (cursor === 0) return [text];
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}
