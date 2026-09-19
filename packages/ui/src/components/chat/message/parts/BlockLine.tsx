import React from 'react';

type BlockLineProps = {
    onToggle?: () => void;
    topOffset?: number;
    bottomOffset?: number;
};

/**
 * The vertical line left of a collapsible chat block's body. Doubles as a
 * click target: clicking it folds/collapses (or expands) the block, the same
 * way as clicking the block's header. Blocks rendered as native <details>
 * pass no onToggle; the nearest one is toggled instead. The hit area is a
 * 12px strip centered on the 1px line, sized with inline styles so it does
 * not depend on compiled Tailwind classes.
 */
export const BlockLine: React.FC<BlockLineProps> = ({ onToggle, topOffset = 0, bottomOffset = 0 }) => (
    <span
        aria-hidden="true"
        className="absolute cursor-pointer"
        style={{ left: -6, top: topOffset, bottom: bottomOffset, width: 12 }}
        onClick={(event) => {
            event.stopPropagation();
            if (onToggle) {
                onToggle();
                return;
            }
            const details = event.currentTarget.closest('details');
            if (details) {
                details.open = !details.open;
            }
        }}
    >
        <span
            className="absolute w-px"
            style={{ left: 6, top: topOffset, bottom: bottomOffset, backgroundColor: 'var(--tools-border)' }}
        />
    </span>
);
