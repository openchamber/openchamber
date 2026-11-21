import React from 'react';

interface LiveActivityCollapseProps {
    expanded: boolean;
    children: React.ReactNode;
    id?: string;
}

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
