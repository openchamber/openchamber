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

const LOCAL_IMAGE_RE = /(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
const PAGE_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;
const OLDER_SERVER_MAX_IMAGES = 12;

export function renderPageImageSources(html: string): string[] {
    const sources = new Set<string>();
    for (const match of html.matchAll(LOCAL_IMAGE_RE)) {
        const source = match[2] ?? match[3];
        if (source) sources.add(source);
    }
    return [...sources];
}

const dataUrlBytes = (url: string): number => Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);

export function inlineRenderPageImages(html: string, images: ReadonlyMap<string, string>): string {
    return html.replace(LOCAL_IMAGE_RE, (match: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
        const url = images.get(quoted ?? bare ?? '');
        if (!url) return match;
        return quote ? `${quote}${url}${quote}` : `url(${url})`;
    });
}

type PrepareImages = typeof prepareLocalMarkdownImages;

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
    for (const oldest of rememberedPages.keys()) {
        if (rememberedCharacters <= MAX_REMEMBERED_CHARACTERS || oldest === partId) break;
        forgetPage(oldest);
    }
};

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
