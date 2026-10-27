import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
    loadPreparedImageAsDataUrl,
    prepareLocalMarkdownImages,
    resolveWorkspaceMarkdownImageSource,
} from '../../markdown/markdownImageAssets';

// A local image a page names by its absolute path: a quoted string (an src
// attribute, a CSS url("..."), a string in the page's script) or an unquoted
// CSS url(...). A quoted path may hold spaces (macOS names screenshots that
// way); an unquoted one ends at the first space or parenthesis. The host
// filters these paths against the program's initial media sources.
const LOCAL_IMAGE_RE = /(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
// File metadata is shared; each page has its own weight budget.
const PAGE_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;

/** The local image paths a page names, in order, once each. */
export function renderPageImageSources(html: string): string[] {
    const sources = new Set<string>();
    for (const match of html.matchAll(LOCAL_IMAGE_RE)) {
        const source = match[2] ?? match[3];
        if (source) sources.add(source);
    }
    return [...sources];
}

/** The file size behind a base64 data URL. */
const dataUrlBytes = (url: string): number => (
    Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4) - (url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0)
);

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
 * existing stat/raw routes, in page order up to the page's weight budget, or in VS Code
 * through its workspace file bridge, one by one up to the same budget. One
 * image that fails does not stop the others.
 */
async function loadRenderPageImages({ sources, sessionId, messageId, directory, signal }: {
    sources: string[];
    sessionId: string;
    messageId: string;
    directory: string;
    signal: AbortSignal;
}): Promise<Map<string, string>> {
    const images = new Map<string, string>();
    const skip = () => undefined;
    if (isVSCodeRuntime()) {
        let bytes = 0;
        for (const source of sources) {
            const url = await resolveWorkspaceMarkdownImageSource(source, directory, signal).catch(skip);
            if (!url) continue;
            bytes += dataUrlBytes(url);
            if (bytes > PAGE_IMAGE_BUDGET_BYTES) break;
            images.set(source, url);
        }
        return images;
    }
    const request = { sources, directory, sessionId, messageId, signal };
    const prepared = await prepareLocalMarkdownImages(request);
    let loadedBytes = 0;
    for (const source of sources) {
        const image = prepared.get(source);
        if (image?.status !== 'ready') continue;
        const loaded = await loadPreparedImageAsDataUrl(image, directory, signal, PAGE_IMAGE_BUDGET_BYTES - loadedBytes).catch(skip);
        if (loaded === null) break;
        if (!loaded) continue;
        loadedBytes += loaded.size;
        images.set(source, loaded.url);
    }
    return images;
}

// A timeline row unmounts when it scrolls away; the page it showed comes back
// without reading its images again. Pages are kept by weight, since each holds
// its images as data URLs, about a byte of memory per character: past the
// budget the oldest go, and such a page reads its images again when it comes
// back.
const MAX_REMEMBERED_CHARACTERS = 100 * 1024 * 1024;
const rememberedPages = new Map<string, { html: string; inlined: string }>();
let rememberedCharacters = 0;
const forgetPage = (partId: string) => {
    const page = rememberedPages.get(partId);
    if (!page) return;
    rememberedPages.delete(partId);
    rememberedCharacters -= page.inlined.length;
};
const rememberPage = (partId: string, html: string, inlined: string) => {
    forgetPage(partId);
    rememberedPages.set(partId, { html, inlined });
    rememberedCharacters += inlined.length;
    // Deleting the key just visited is safe while a Map iterates its keys.
    for (const oldest of rememberedPages.keys()) {
        if (rememberedCharacters <= MAX_REMEMBERED_CHARACTERS || oldest === partId) break;
        forgetPage(oldest);
    }
};

/**
 * The page's HTML with its local images in place, or null while they load. A
 * page that names none is ready at once. The page is drawn once its images are
 * in, not before: drawing it again would reload it and lose what its script
 * holds.
 */
export function useOpenUIHtml({
    html,
    sessionId,
    messageId,
    directory,
    pageId,
    renderKey,
    permittedSources,
}: {
    html: string;
    sessionId: string;
    messageId: string;
    directory: string;
    pageId: string;
    renderKey: string;
    permittedSources: readonly string[];
}): string | null {
    const [runtimeKey, setRuntimeKey] = React.useState(getRuntimeKey);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntimeKey(getRuntimeKey())), []);
    const scopedCacheKey = `${runtimeKey}\0${directory}\0${sessionId}\0${messageId}\0${pageId}\0${renderKey}`;
    const sources = React.useMemo(() => {
        const found = renderPageImageSources(html);
        return found.filter((source) => permittedSources.includes(source));
    }, [html, permittedSources]);
    const [loaded, setLoaded] = React.useState(() => {
        const page = rememberedPages.get(scopedCacheKey);
        return page ? { key: scopedCacheKey, page } : null;
    });

    React.useEffect(() => {
        if (sources.length === 0) return;
        const remembered = rememberedPages.get(scopedCacheKey);
        if (remembered?.html === html) {
            setLoaded({ key: scopedCacheKey, page: remembered });
            return;
        }
        setLoaded(null);
        const controller = new AbortController();
        // Failed inspection draws the page with its original image paths.
        loadRenderPageImages({ sources, sessionId, messageId, directory, signal: controller.signal })
            .catch(() => new Map<string, string>())
            .then((images) => {
                if (controller.signal.aborted) return;
                const page = { html, inlined: inlineRenderPageImages(html, images) };
                rememberPage(scopedCacheKey, page.html, page.inlined);
                setLoaded({ key: scopedCacheKey, page });
            });
        return () => controller.abort();
    }, [directory, html, messageId, scopedCacheKey, sessionId, sources]);

    if (sources.length === 0) return html;
    return loaded?.key === scopedCacheKey && loaded.page.html === html ? loaded.page.inlined : null;
}
