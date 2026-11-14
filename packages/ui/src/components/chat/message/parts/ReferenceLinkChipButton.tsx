import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { INTERACTIVE_REFERENCE_CHIP_CLASS, REFERENCE_CHIP_LABEL_CLASS } from '@/lib/messages/inlineMessageLinks';
import type { ReferenceLinkChip } from '@/lib/messages/referenceLinkChip';

// Inline minimums opt out of the mobile 36px button floor.
const INLINE_BUTTON_STYLE = { minHeight: 0, minWidth: 0 };

/**
 * A linked issue, change request or tracker item in sent text: opens it in the
 * Tracker, as the session's linked items do; Cmd or Ctrl opens its page.
 */
export const ReferenceLinkChipButton: React.FC<{ chip: ReferenceLinkChip; url: string }> = ({ chip, url }) => {
    const openTrackerItem = useOpenTrackerItem();
    const directory = useEffectiveDirectory();
    return (
        <button
            type="button"
            dir="ltr"
            className={`${INTERACTIVE_REFERENCE_CHIP_CLASS} [unicode-bidi:isolate]`}
            style={INLINE_BUTTON_STYLE}
            title={chip.title}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openTrackerItem(url, directory, event);
            }}
        >
            <Icon name={chip.icon} className="h-[1.1em] w-[1.1em] shrink-0" />
            <span className={REFERENCE_CHIP_LABEL_CLASS}>{chip.label}</span>
        </button>
    );
};
