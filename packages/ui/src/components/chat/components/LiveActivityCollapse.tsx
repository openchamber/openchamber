import React from 'react';

interface LiveActivityCollapseProps {
    expanded: boolean;
    children: React.ReactNode;
    id?: string;
}

/**
 * A turn's folded work. It opens and closes at once: the work above the
 * reader is its own list rows (`timelineRows.ts`), and the list keeps the
 * reader's place when a row above them changes size.
 */
export function LiveActivityCollapse({ expanded, children, id }: LiveActivityCollapseProps) {
    return (
        <div
            id={id}
            aria-hidden={!expanded}
            inert={!expanded}
            data-live-activity-content="true"
            style={expanded ? undefined : { height: 0, overflow: 'hidden' }}
        >
            {expanded ? children : null}
        </div>
    );
}
