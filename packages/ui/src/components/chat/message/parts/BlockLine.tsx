import React from 'react';

type BlockLineProps = {
    onToggle?: () => void;
    topOffset?: number;
    bottomOffset?: number;
};

export const BlockLine: React.FC<BlockLineProps> = ({ onToggle, topOffset = 0, bottomOffset = 0 }) => (
    <span
        aria-hidden="true"
        className="absolute cursor-pointer"
        style={{ insetInlineStart: -6, top: topOffset, bottom: bottomOffset, width: 12 }}
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
            style={{ insetInlineStart: 6, top: 0, bottom: 0, backgroundColor: 'var(--tools-border)' }}
        />
    </span>
);

type BlockBodyProps = {
    onToggle: () => void;
    style?: React.CSSProperties;
    children: React.ReactNode;
};

export const BlockBody: React.FC<BlockBodyProps> = ({ onToggle, style, children }) => (
    <div className="relative ms-2 ps-3 pt-1 pb-2" style={style}>
        <BlockLine onToggle={onToggle} />
        {children}
    </div>
);
