import React from 'react';
import { animate } from 'motion';

interface LiveActivityCollapseProps {
    expanded: boolean;
    children: React.ReactNode;
    id?: string;
    animateOnMount?: boolean;
}

export function LiveActivityCollapse({ expanded, children, id, animateOnMount = false }: LiveActivityCollapseProps) {
    const ref = React.useRef<HTMLDivElement>(null);
    const previousExpanded = React.useRef(expanded || animateOnMount);
    const [retained, setRetained] = React.useState(expanded || animateOnMount);
    const mounted = expanded || retained;

    React.useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const settle = () => {
            element.style.height = expanded ? 'auto' : '0px';
            element.style.overflow = expanded ? 'visible' : 'hidden';
            setRetained(expanded);
        };
        // Suspense can clean up a layout effect while retaining its DOM, then
        // replay setup on reveal. The old animation was stopped, but the ref
        // still records its target. Skipping setup here would freeze the
        // measured pre-collapse height and retain an empty historical region.
        if (previousExpanded.current === expanded) {
            settle();
            return;
        }
        previousExpanded.current = expanded;
        if (expanded) setRetained(true);
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            settle();
            return;
        }
        element.style.height = expanded ? '0px' : `${element.scrollHeight}px`;
        element.style.overflow = 'hidden';
        const animation = animate(element, { height: expanded ? 'auto' : '0px' }, {
            duration: 0.18,
            ease: [0.16, 1, 0.3, 1],
        });
        let cancelled = false;
        const finish = () => {
            if (!cancelled) settle();
        };
        void animation.finished.then(finish, finish);
        return () => {
            cancelled = true;
            animation.stop();
        };
    }, [expanded]);

    return (
        <div
            ref={ref}
            id={id}
            aria-hidden={!expanded}
            inert={!expanded}
            data-live-activity-content="true"
            style={{
                height: mounted ? 'auto' : 0,
                overflow: mounted ? 'visible' : 'hidden',
                overflowAnchor: 'none',
            }}
        >
            {mounted ? children : null}
        </div>
    );
}
