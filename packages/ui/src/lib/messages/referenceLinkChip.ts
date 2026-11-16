/**
 * How a linked issue, change request or tracker item draws as a chip in text:
 * its number and title, with its kind's mark. Shared by the composer and sent
 * messages, so a pasted link reads the same before and after Enter.
 */

import type { IconName } from '@/components/icon/icons';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { trackerPresentation } from '@/lib/trackers/presentation';

/** What a chip needs of an item: a composer reference, or the context payload a sent message carries. */
type ReferenceLinkChipSource =
    | { kind: 'tracker-item'; provider: string; identifier: string; title: string }
    | { kind: 'change-request' | 'repository-issue' | 'repository-discussion'; provider?: string; number: number; title: string }
    | { kind: 'guest'; id: string; title: string };

export type ReferenceLinkChip = { label: string; title: string; icon: IconName };

const CHIP_TITLE_LENGTH = 48;
// An item written before providers other than GitHub existed names none: it is GitHub's.
const LEGACY_PROVIDER = 'github';

export const referenceLinkChip = (
    reference: ReferenceLinkChipSource,
    descriptorOf: (provider: string) => SourceControlProviderDescriptor,
): ReferenceLinkChip => {
    const number = (() => {
        switch (reference.kind) {
            case 'tracker-item': return reference.identifier;
            case 'change-request': return formatChangeRequestReference(descriptorOf(reference.provider ?? LEGACY_PROVIDER), reference.number);
            case 'repository-issue':
            case 'repository-discussion': return `${descriptorOf(reference.provider ?? LEGACY_PROVIDER).terminology.issuePrefix}${reference.number}`;
            case 'guest': return reference.id;
        }
    })();
    const icon: IconName = reference.kind === 'tracker-item'
        ? trackerPresentation(reference.provider).icon
        : reference.kind === 'change-request' ? 'git-pull-request' : 'record-circle';
    const title = reference.title.length > CHIP_TITLE_LENGTH
        ? `${reference.title.slice(0, CHIP_TITLE_LENGTH - 1).trimEnd()}…`
        : reference.title;
    return { label: `${number} ${title}`, title: `${number} ${reference.title}`, icon };
};
