import React from 'react';

import type { Part } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MessageFilesDisplay } from '../FileAttachment';
import UserTextPart from '../message/parts/UserTextPart';
import { isEmptyTextPart } from '../message/partUtils';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getPromptPreviewText } from '../lib/messagePreview';

interface PinnedPromptStripProps {
    scrollRef: React.RefObject<HTMLElement | null>;
    turnId: string;
    promptParts: Part[];
    /** Scrolls the timeline to the prompt itself. */
    onGoToPrompt: (turnId: string) => void;
}

const noop = () => {};

/** Scroll distance over which the leaving bubble turns into the strip. */
const MORPH_DISTANCE_PX = 72;
/** The user bubble's text inset (px-5 py-3) and the strip's (px-3), for the text's start point. */
const BUBBLE_PADDING_X = 20;
const BUBBLE_PADDING_Y = 12;
const STRIP_PADDING_X = 12;

/**
 * The phone's sticky user header: one line naming the prompt of the turn on
 * screen, shown once that prompt has scrolled above the viewport. A full
 * sticky bubble took a quarter of a phone screen.
 */
export const PinnedPromptStrip: React.FC<PinnedPromptStripProps> = ({ scrollRef, turnId, promptParts, onGoToPrompt }) => {
    const { t } = useI18n();
    const [promptAbove, setPromptAbove] = React.useState(false);
    const [sheetOpen, setSheetOpen] = React.useState(false);

    const stripRef = React.useRef<HTMLDivElement | null>(null);
    const surfaceRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);

    // The bubble turns into the strip as it scrolls away: over the last
    // MORPH_DISTANCE_PX before it leaves, the strip is drawn at a rect
    // interpolated between the bubble and its own place, while the bubble
    // fades, so the two read as one element. Driven by the scroll itself, at
    // most once per frame, with styles written straight to the DOM. The list
    // recycles row nodes, so the bubble is looked up again on each frame.
    React.useEffect(() => {
        const root = scrollRef.current;
        const strip = stripRef.current;
        const surface = surfaceRef.current;
        const content = contentRef.current;
        if (!root || !strip || !surface || !content) return;
        let frame = 0;
        let fadedBubble: HTMLElement | null = null;
        const fadeBubble = (bubble: HTMLElement | null, opacity: number) => {
            if (fadedBubble && fadedBubble !== bubble) fadedBubble.style.opacity = '';
            fadedBubble = bubble;
            if (bubble) bubble.style.opacity = opacity >= 1 ? '' : String(opacity);
        };
        const check = () => {
            frame = 0;
            const turn = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
            const bubble = turn?.querySelector<HTMLElement>('[data-user-message-bubble]') ?? null;
            const rootTop = root.getBoundingClientRect().top;
            const parent = (strip.offsetParent ?? root).getBoundingClientRect();
            const target = { left: parent.left + strip.offsetLeft, top: parent.top + strip.offsetTop, width: strip.offsetWidth, height: strip.offsetHeight };
            if (target.width === 0 || target.height === 0) return;
            let progress: number;
            let from = target;
            if (bubble) {
                const rect = bubble.getBoundingClientRect();
                from = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
                progress = Math.min(1, Math.max(0, (target.top + target.height + MORPH_DISTANCE_PX - rect.bottom) / MORPH_DISTANCE_PX));
            } else {
                progress = turn && turn.getBoundingClientRect().top < rootTop ? 1 : 0;
            }
            const lerp = (a: number, b: number) => a + (b - a) * progress;
            const width = lerp(from.width, target.width);
            const height = lerp(from.height, target.height);
            const dx = lerp(from.left, target.left) - target.left;
            const dy = lerp(from.top, target.top) - target.top;
            // The surface stretches between the two shapes; the text only
            // travels, from the bubble's first line, so it never distorts.
            surface.style.transform = progress >= 1 ? '' : `translate(${dx}px, ${dy}px) scale(${width / target.width}, ${height / target.height})`;
            surface.style.opacity = String(Math.min(1, progress * 2));
            content.style.transform = progress >= 1 ? '' : `translate(${dx + lerp(BUBBLE_PADDING_X - STRIP_PADDING_X, 0)}px, ${dy + lerp(BUBBLE_PADDING_Y, 0)}px)`;
            content.style.opacity = String(Math.max(0, progress * 2 - 1));
            fadeBubble(bubble, 1 - progress);
            const above = progress >= 1;
            setPromptAbove((current) => (current === above ? current : above));
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
        check();
        root.addEventListener('scroll', schedule, { passive: true });
        return () => {
            root.removeEventListener('scroll', schedule);
            if (frame) cancelAnimationFrame(frame);
            fadeBubble(null, 1);
        };
    }, [scrollRef, turnId]);

    const text = React.useMemo(() => getPromptPreviewText(promptParts, t), [promptParts, t]);
    const textParts = React.useMemo(() => promptParts.filter((part) => part.type === 'text' && !isEmptyTextPart(part)), [promptParts]);
    const attachmentFilenames = React.useMemo(() => promptParts.flatMap((part) => (
        part.type === 'file' && part.filename ? [part.filename] : []
    )), [promptParts]);


    return (
        <>
            <div
                ref={stripRef}
                // Same surface as the user bubble, so the morph reads as one element.
                className={cn('absolute inset-x-2.5 top-1.5 z-20', !promptAbove && 'pointer-events-none')}
                aria-hidden={!promptAbove}
                hidden={!text}
            >
                {/* Same surface as the user bubble, so the morph reads as one element. */}
                <div
                    ref={surfaceRef}
                    aria-hidden="true"
                    className="absolute inset-0 origin-top-left rounded-xl border border-primary/5 opacity-0 shadow-sm"
                    style={{ backgroundColor: 'var(--chat-user-message-bg)' }}
                />
                <div ref={contentRef} className="relative flex items-center gap-1 px-3 opacity-0">
                <button
                    type="button"
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-none"
                    aria-label={t('chat.pinnedPrompt.openAria')}
                    onClick={() => setSheetOpen(true)}
                    tabIndex={promptAbove ? 0 : -1}
                >
                    <Icon name="pushpin-2" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span dir="auto" className="min-w-0 flex-1 truncate typography-meta text-foreground">{text.replace(/\n/g, ' ')}</span>
                </button>
                </div>
            </div>
            <MobileOverlayPanel
                open={sheetOpen}
                onClose={() => setSheetOpen(false)}
                title={t('chat.pinnedPrompt.sheetTitle')}
                footer={(
                    <Button
                        variant="secondary"
                        className="w-full normal-case"
                        onClick={() => {
                            setSheetOpen(false);
                            onGoToPrompt(turnId);
                        }}
                    >
                        <Icon name="arrow-up" className="size-4" aria-hidden="true" />
                        {t('chat.pinnedPrompt.goToMessage')}
                    </Button>
                )}
            >
                {/* The same parts the bubble draws: attachments first, then the
                    text, always expanded. */}
                <div className="px-3 pb-3 leading-relaxed text-foreground/90">
                    <MessageFilesDisplay files={promptParts} compact className={textParts.length > 0 ? 'mb-2' : 'mt-0'} />
                    {textParts.map((part, index) => (
                        <UserTextPart
                            key={`pinned-${index}`}
                            part={part}
                            isMobile
                            messageExpanded
                            onExpandMessage={noop}
                            partIndex={index}
                            onTruncationChange={noop}
                            onCollapsedLinesChange={noop}
                            attachmentFilenames={attachmentFilenames}
                        />
                    ))}
                </div>
            </MobileOverlayPanel>
        </>
    );
};
