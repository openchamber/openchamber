import * as React from 'react';

const revealSection = (section: HTMLElement | null, align: 'start' | 'end') => {
    let scroller = section?.parentElement ?? null;
    while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!section || !scroller) return;
    if (align === 'end') scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
};

export const useRevealOnExpand = (expanded: boolean, align: 'start' | 'end') => {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        if (expanded) revealSection(ref.current, align);
    }, [align, expanded]);
    return ref;
};
