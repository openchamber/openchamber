import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useEmojiShortcodes } from '@/lib/emoji/shortcodes';
import { useI18n } from '@/lib/i18n';

import { ReferenceMarkdownRewriteContext } from './projectUploads';
import { ReferenceLinksContext } from './referenceLinks';

const MARKDOWN_CLASS = '[&_img]:max-w-full [&_img]:h-auto';
const BODY_HEIGHT_CLASS = 'max-h-[13rem] overflow-hidden';
const FADE_STYLE: React.CSSProperties = {
    maskImage: 'linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)',
    WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)',
};

const useIsomorphicLayoutEffect = globalThis.window ? React.useLayoutEffect : React.useEffect;

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
            directory={links.directory}
        />
    );
};

export const CollapsedBody: React.FC<{ collapsed: boolean; children: React.ReactNode }> = ({ collapsed, children }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const [overflowing, setOverflowing] = React.useState(true);
    const bodyRef = React.useRef<HTMLDivElement>(null);

    useIsomorphicLayoutEffect(() => {
        if (!collapsed || expanded) return;
        const node = bodyRef.current;
        if (!node) return;
        const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
        measure();
        const Observer = globalThis.ResizeObserver;
        if (!Observer) return;
        const observer = new Observer(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [collapsed, expanded]);

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
    if (expanded) {
        return (
            <>
                {children}
                {overflowing ? control(false) : null}
            </>
        );
    }
    return (
        <>
            <div
                ref={bodyRef}
                data-collapsed-body
                className={BODY_HEIGHT_CLASS}
                style={overflowing ? FADE_STYLE : undefined}
            >
                {children}
            </div>
            {overflowing ? control(true) : null}
        </>
    );
};
