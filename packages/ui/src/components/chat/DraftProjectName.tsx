import React from 'react';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';

/**
 * The project's name inside the new-session heading. Picking another project
 * eases the name into its new width, so the line around it slides instead of
 * jumping. An inline block clipped at its edge, top-aligned so its text sits
 * on the heading's line.
 */
export const DraftProjectName: React.FC<{ label: string }> = ({ label }) => {
    const ref = React.useRef<HTMLSpanElement>(null);
    useWidthMorph(ref);
    return <span ref={ref} className="inline-block max-w-full overflow-hidden whitespace-nowrap align-top font-medium">{label}</span>;
};
