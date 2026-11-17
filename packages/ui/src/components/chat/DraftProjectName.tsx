import React from 'react';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';

export const DraftProjectName: React.FC<{ label: string }> = ({ label }) => {
    const ref = React.useRef<HTMLSpanElement>(null);
    useWidthMorph(ref);
    return <span ref={ref} className="inline-block max-w-full overflow-hidden whitespace-nowrap align-top font-medium">{label}</span>;
};
