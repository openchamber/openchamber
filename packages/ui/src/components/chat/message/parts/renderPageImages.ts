import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ToolPart } from '@/lib/opencode/model';
import {
    ImageGrantRequestError,
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
// VS Code has no image grant route to weigh a page, so the chat keeps the
// server's budget there itself (RENDER_PAGE_IMAGE_BUDGET_BYTES in
// packages/web/server/lib/openchamber-control/render-page.js).
const PAGE_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;
// A server from before the weight budget refuses a request naming more images.
const OLDER_SERVER_MAX_IMAGES = 12;

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
const dataUrlBytes = (url: string): number => Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);

/** The page with each loaded image's path swapped for its data URL; an image that did not load keeps its path. */
export function inlineRenderPageImages(html: string, images: ReadonlyMap<string, string>): string {
    return html.replace(LOCAL_IMAGE_RE, (match: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
        const url = images.get(quoted ?? bare ?? '');
        if (!url) return match;
        return quote ? `${quote}${url}${quote}` : `url(${url})`;
    });
}

type PrepareImages = typeof prepareLocalMarkdownImages;

/**
 * Asks the image grant route for a page's images. A server from before the
 * weight budget refuses the whole request with a 400 when the page names more
 * than 12 images; the page then gets its first 12, as it did from that server
 * before. Any other failure stays a failure: a request without the page's call
 * id gets no weight budget.
 */
export function prepareRenderPageImages(
    request: Parameters<PrepareImages>[0] & { callId: string },
    prepare: PrepareImages = prepareLocalMarkdownImages,
): ReturnType<PrepareImages> {
    const { sources, directory, sessionId, messageId, signal } = request;
    return prepare(request).catch((error) => {
        const olderServer = error instanceof ImageGrantRequestError && error.status === 400;
        if (!olderServer || sources.length <= OLDER_SERVER_MAX_IMAGES || signal.aborted) throw error;
        return prepare({ sources: sources.slice(0, OLDER_SERVER_MAX_IMAGES), directory, sessionId, messageId, signal });
    });
}

/**
 * Loads the images a page names as data URLs. The page runs in an opaque
 * origin and cannot read files, so the chat reads them for it: through the
 * image grant route, which allows only paths the message's page names and
 * only as many, in page order, as fit the page's weight budget, or in VS Code
 * through its workspace file bridge, one by one up to the same budget. One
 * image that fails does not stop the others.
 */
async function loadRenderPageImages({ sources, sessionId, messageId, callId, directory, signal }: {
    sources: string[];
    sessionId: string;
    messageId: string;
    callId: string;
    directory: string;
    signal: AbortSignal;
}): Promise<Map<string, string>> {
    const images = new Map<string, string>();
    const keep = (source: string) => (url: string) => {
        images.set(source, url);
    };
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
    const prepared = await prepareRenderPageImages({ sources, directory, sessionId, messageId, callId, signal });
    await Promise.all(sources.map((source) => {
        const image = prepared.get(source);
        if (image?.status !== 'ready') return undefined;
        return loadPreparedImageAsDataUrl(image, directory, signal).then(keep(source), skip);
    }));
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
export function useRenderPageHtml(part: ToolPart, html: string): string | null {
    const directory = useEffectiveDirectory() ?? '';
    const sources = React.useMemo(() => renderPageImageSources(html), [html]);
    const [loaded, setLoaded] = React.useState(() => rememberedPages.get(part.id) ?? null);
    const { id: partId, sessionID: sessionId, messageID: messageId, callID: callId } = part;

    React.useEffect(() => {
        if (sources.length === 0) return;
        const remembered = rememberedPages.get(partId);
        if (remembered?.html === html) {
            setLoaded(remembered);
            return;
        }
        const controller = new AbortController();
        // A failed grant request draws the page with its paths, as images that did not load.
        loadRenderPageImages({ sources, sessionId, messageId, callId, directory, signal: controller.signal })
            .catch(() => new Map<string, string>())
            .then((images) => {
                if (controller.signal.aborted) return;
                const page = { html, inlined: inlineRenderPageImages(html, images) };
                rememberPage(partId, page.html, page.inlined);
                setLoaded(page);
            });
        return () => controller.abort();
    }, [callId, directory, html, messageId, partId, sessionId, sources]);

    if (sources.length === 0) return html;
    return loaded?.html === html ? loaded.inlined : null;
}
