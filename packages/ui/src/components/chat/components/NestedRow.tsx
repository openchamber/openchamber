import React from 'react';

const INDENT_PX = 20;
const LINE_OFFSET_PX = 8;

type IndentStyle = React.CSSProperties & { '--chat-row-indent': string };
const indentStyle = (depth: number): IndentStyle => ({ '--chat-row-indent': `${depth * INDENT_PX}px` });

export const NestedRow: React.FC<{ depth: number; children: React.ReactNode }> = ({ depth, children }) => {
    return (
        <div className="relative w-full">
            {depth === 0 ? null : <div className="pointer-events-none absolute inset-0" aria-hidden>
                <div className="chat-message-column h-full">
                    <div className="relative h-full">
                        {Array.from({ length: depth }, (_, level) => (
                            <span
                                key={level}
                                className="absolute inset-y-0 w-px"
                                style={{ insetInlineStart: level * INDENT_PX + LINE_OFFSET_PX, backgroundColor: 'var(--tools-border)' }}
                            />
                        ))}
                    </div>
                </div>
            </div>}
            <div style={indentStyle(depth)}>{children}</div>
        </div>
    );
};

export const NestedBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="relative ps-5">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px" style={{ insetInlineStart: LINE_OFFSET_PX, backgroundColor: 'var(--tools-border)' }} />
        {children}
    </div>
);
