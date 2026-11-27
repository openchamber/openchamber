import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useEmojiShortcodes } from '@/lib/emoji/shortcodes';
import { useI18n } from '@/lib/i18n';

import { ReferenceMarkdownRewriteContext } from './projectUploads';
import { ReferenceLinksContext } from './referenceLinks';

const MARKDOWN_CLASS = '[&_img]:max-w-full [&_img]:h-auto';
const BODY_HEIGHT_CLASS = 'max-h-[min(13rem,60vh)] oc-row-clip';
const FADE_STYLE: React.CSSProperties = {
    maskImage: 'linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)',
    WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)',
};
const TABBABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, video[controls], audio[controls], iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const CLIP_EPSILON = 1;

const useIsomorphicLayoutEffect = globalThis.window ? React.useLayoutEffect : React.useEffect;

const hideFromTabOrder = (root: HTMLElement, clippedBottom: number) => {
    const saved: Array<[HTMLElement, string | null]> = [];
    for (const element of root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)) {
        if (element.getBoundingClientRect().top < clippedBottom - CLIP_EPSILON) continue;
        saved.push([element, element.getAttribute('tabindex')]);
        element.setAttribute('tabindex', '-1');
    }
    return () => {
        for (const [element, tabIndex] of saved) {
            if (tabIndex === null) element.removeAttribute('tabindex');
            else element.setAttribute('tabindex', tabIndex);
        }
    };
};

export const ReferenceBody: React.FC<{ content: string }> = ({ content }) => {
    const rewrite = React.useContext(ReferenceMarkdownRewriteContext);
    const links = React.useContext(ReferenceLinksContext);
    const shown = React.useMemo(() => (rewrite ? rewrite(content) : content), [content, rewrite]);
    const emojiShortcodes = useEmojiShortcodes(shown);
    return (
        <SimpleMarkdownRenderer
            content={shown}
            className={MARKDOWN_CLASS}
            enableFileReferences={false}
            allowRawHtml
            singleTilde
            repositoryLinks={links.repository}
            emojiShortcodes={emojiShortcodes}
            directory={links.directory} hostsDiagramPreview
        />
    );
};

export const CollapsedBody: React.FC<{ collapsed: boolean; children: React.ReactNode }> = ({ collapsed, children }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const [overflowing, setOverflowing] = React.useState(true);
    const clippedRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const clipping = collapsed && !expanded;

    useIsomorphicLayoutEffect(() => {
        if (!clipping) return;
        const clipped = clippedRef.current;
        const content = contentRef.current;
        if (!clipped || !content) return;
        let restoreTabOrder = () => {};
        const measure = () => {
            restoreTabOrder();
            restoreTabOrder = () => {};
            const contentHeight = Math.max(clipped.scrollHeight, content.getBoundingClientRect().height);
            const overflow = contentHeight > clipped.clientHeight + 1;
            setOverflowing(overflow);
            if (overflow) restoreTabOrder = hideFromTabOrder(clipped, clipped.getBoundingClientRect().bottom);
        };
        measure();
        const Mutations = globalThis.MutationObserver;
        const mutations = Mutations ? new Mutations(measure) : null;
        mutations?.observe(content, { childList: true, subtree: true, characterData: true });
        const Resize = globalThis.ResizeObserver;
        const resizes = Resize ? new Resize(measure) : null;
        resizes?.observe(clipped);
        resizes?.observe(content);
        return () => {
            mutations?.disconnect();
            resizes?.disconnect();
            restoreTabOrder();
        };
    }, [clipping]);

    const control = (expand: boolean) => (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ms-1.5 mt-1 min-h-9 gap-1"
            onClick={() => setExpanded(expand)}
            aria-expanded={!expand}
        >
            <Icon name={expand ? 'arrow-down-s' : 'arrow-up-s'} className="size-3.5" />
            {t(expand ? 'references.picker.preview.expand' : 'references.picker.preview.collapse')}
        </Button>
    );

    if (!collapsed) return <>{children}</>;
    return (
        <>
            <div
                ref={clippedRef}
                data-collapsed-body={clipping ? '' : undefined}
                className={clipping ? BODY_HEIGHT_CLASS : undefined}
                style={clipping && overflowing ? FADE_STYLE : undefined}
            >
                <div ref={contentRef} data-collapsed-content="">{children}</div>
            </div>
            {overflowing ? control(!expanded) : null}
        </>
    );
};
