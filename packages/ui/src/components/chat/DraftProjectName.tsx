import React from 'react';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';

const Segmenter = globalThis.Intl?.Segmenter;
const graphemes = Segmenter ? new Segmenter() : null;

const leadingPunctuation = (text: string): string => text.match(/^\s*\p{P}+/u)?.[0] ?? '';

const lastGraphemeStart = (label: string): number => {
    const end = label.endsWith('⁩') ? label.length - 1 : label.length;
    return graphemes?.segment(label).containing(end - 1)?.index
        ?? label.slice(0, end).match(/\P{M}\p{M}*$/u)?.index
        ?? label.length;
};

const MORPH_CLASS = 'inline-block max-w-full align-top font-medium data-[width-morphing]:overflow-hidden data-[width-morphing]:supports-[overflow:clip]:overflow-x-clip data-[width-morphing]:supports-[overflow:clip]:overflow-y-visible data-[width-morphing]:whitespace-nowrap';

export const DraftProjectName: React.FC<{ label: string; trailingText?: string }> = ({ label, trailingText }) => {
    const ref = React.useRef<HTMLSpanElement>(null);
    useWidthMorph(ref);
    if (trailingText === undefined) {
        return <span ref={ref} className="inline-block max-w-full overflow-hidden supports-[overflow:clip]:overflow-x-clip supports-[overflow:clip]:overflow-y-visible whitespace-nowrap align-top font-medium">{label}</span>;
    }

    const punctuation = leadingPunctuation(trailingText);
    const words = trailingText.slice(punctuation.length);
    if (!punctuation) {
        return <><span ref={ref} className={MORPH_CLASS}>{label}</span>{words}</>;
    }

    const joinAt = lastGraphemeStart(label);
    const suffix = <span className="font-normal">{punctuation}</span>;
    return (
        <>
            <span ref={ref} className={MORPH_CLASS}>
                {label.slice(0, joinAt)}
                {joinAt < label.length ? <span className="whitespace-nowrap">{label.slice(joinAt)}{suffix}</span> : suffix}
            </span>
            {words}
        </>
    );
};
