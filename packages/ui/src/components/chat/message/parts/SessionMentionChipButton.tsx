import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { INTERACTIVE_REFERENCE_CHIP_CLASS, REFERENCE_CHIP_LABEL_CLASS } from '@/lib/messages/inlineMessageLinks';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import type { SessionLinkTarget } from '@/lib/sessionLinks';
import type { SessionMentionChip } from '@/lib/messages/sessionMentionChip';

// Inline minimums opt out of the mobile 36px button floor.
const INLINE_BUTTON_STYLE = { minHeight: 0, minWidth: 0 };

/** A mentioned session or message in sent text: opens it in the app. */
export const SessionMentionChipButton: React.FC<{ chip: SessionMentionChip; target: SessionLinkTarget }> = ({ chip, target }) => (
    <button
        type="button"
        className={INTERACTIVE_REFERENCE_CHIP_CLASS}
        style={INLINE_BUTTON_STYLE}
        title={chip.title}
        onClick={(event) => {
            event.stopPropagation();
            void openSessionLink(target.sessionId, target.messageId);
        }}
    >
        <Icon name={chip.icon} className="h-[1.1em] w-[1.1em] shrink-0" />
        <span className={REFERENCE_CHIP_LABEL_CLASS}>{chip.label}</span>
    </button>
);

