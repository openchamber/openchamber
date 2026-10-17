import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ToolPart } from '@/lib/opencode/model';
import {
    loadPreparedImageAsDataUrl,
    prepareLocalMarkdownImages,
    resolveWorkspaceMarkdownImageSource,
} from '../../markdown/markdownImageAssets';

// A local image a page names by its absolute path: a quoted string (an src
// attribute, a CSS url("..."), a string in the page's script) or an unquoted
// CSS url(...). A quoted path may hold spaces (macOS names screenshots that
// way); an unquoted one ends at the first space or parenthesis. The server
// authorizes the same paths with the same rule (renderPageImageSources in
// packages/web/server/lib/openchamber-control/render-page.js).
const LOCAL_IMAGE_RE = /(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
// The image grant route prepares at most this many images in one request.
const MAX_LOCAL_IMAGES = 12;

/** The local image paths a page names, in order, at most twelve. */
export function renderPageImageSources(html: string): string[] {
    const sources = new Set<string>();
    for (const match of html.matchAll(LOCAL_IMAGE_RE)) {
        const source = match[2] ?? match[3];
        if (source) sources.add(source);
        if (sources.size === MAX_LOCAL_IMAGES) break;
    }
    return [...sources];
}

/** The page with each loaded image's path swapped for its data URL; an image that did not load keeps its path. */
export function inlineRenderPageImages(html: string, images: ReadonlyMap<string, string>): string {
    return html.replace(LOCAL_IMAGE_RE, (match: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
        const url = images.get(quoted ?? bare ?? '');
        if (!url) return match;
        return quote ? `${quote}${url}${quote}` : `url(${url})`;
    });
}

/**
 * Loads the images a page names as data URLs. The page runs in an opaque
 * origin and cannot read files, so the chat reads them for it: through the
 * image grant route, which allows only paths the message's page names, or in
 * VS Code through its workspace file bridge. One image that fails does not
 * stop the others.
 */
async function loadRenderPageImages({ sources, sessionId, messageId, directory, signal }: {
    sources: string[];
    sessionId: string;
    messageId: string;
    directory: string;
    signal: AbortSignal;
}): Promise<Map<string, string>> {
    const images = new Map<string, string>();
    const keep = (source: string) => (url: string) => {
        images.set(source, url);
    };
    const skip = () => undefined;
    if (isVSCodeRuntime()) {
        await Promise.all(sources.map((source) => resolveWorkspaceMarkdownImageSource(source, directory, signal).then(keep(source), skip)));
        return images;
    }
    const prepared = await prepareLocalMarkdownImages({ sources, directory, sessionId, messageId, signal });
    await Promise.all(sources.map((source) => {
        const image = prepared.get(source);
        if (image?.status !== 'ready') return undefined;
        return loadPreparedImageAsDataUrl(image, directory, signal).then(keep(source), skip);
    }));
    return images;
}

// A timeline row unmounts when it scrolls away; the page it showed comes back
// without reading its images again.
const MAX_REMEMBERED_PAGES = 20;
const rememberedPages = new Map<string, { html: string; inlined: string }>();
const rememberPage = (partId: string, html: string, inlined: string) => {
    rememberedPages.delete(partId);
    rememberedPages.set(partId, { html, inlined });
    if (rememberedPages.size > MAX_REMEMBERED_PAGES) {
        const oldest = rememberedPages.keys().next().value;
        if (oldest !== undefined) rememberedPages.delete(oldest);
    }
};

/**
 * The page's HTML with its local images in place, or null while they load. A
 * page that names none is ready at once. The page is drawn once its images are
 * in, not before: drawing it again would reload it and lose what its script
 * holds.
 */
export function useRenderPageHtml(part: ToolPart, html: string): string | null {
    const directory = useEffectiveDirectory() ?? '';
    const sources = React.useMemo(() => renderPageImageSources(html), [html]);
    const [loaded, setLoaded] = React.useState(() => rememberedPages.get(part.id) ?? null);
    const { id: partId, sessionID: sessionId, messageID: messageId } = part;

    React.useEffect(() => {
        if (sources.length === 0) return;
        const remembered = rememberedPages.get(partId);
        if (remembered?.html === html) {
            setLoaded(remembered);
            return;
        }
        const controller = new AbortController();
        // A failed grant request draws the page with its paths, as images that did not load.
        loadRenderPageImages({ sources, sessionId, messageId, directory, signal: controller.signal })
            .catch(() => new Map<string, string>())
            .then((images) => {
                if (controller.signal.aborted) return;
                const page = { html, inlined: inlineRenderPageImages(html, images) };
                rememberPage(partId, page.html, page.inlined);
                setLoaded(page);
            });
        return () => controller.abort();
    }, [directory, html, messageId, partId, sessionId, sources]);

    if (sources.length === 0) return html;
    return loaded?.html === html ? loaded.inlined : null;
}
