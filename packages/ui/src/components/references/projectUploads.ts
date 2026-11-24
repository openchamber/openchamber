import * as React from 'react';

import { isVideoSource } from '@/components/chat/markdown/markdownVideo';
import type { RepositoryReference } from '@/lib/api/types';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { SourceControlReadContext } from '@/lib/source-control/types';

import { useRepositoryReadContext } from './referenceSources';
import { joinProjectPath } from '@/lib/source-control/projectPath';

const UPLOAD_PATH = String.raw`\/uploads\/[0-9a-f]{32}\/[^\s)"'<>]+`;
const MEDIA_UPLOAD_RE = new RegExp(String.raw`(!\[[^\]]*\]\(\s*<?|\bsrc=["'])(${UPLOAD_PATH})`, 'g');
const LINKED_UPLOAD_RE = new RegExp(String.raw`(\]\(\s*<?|\bhref=["'])(${UPLOAD_PATH})`, 'g');
const ABSOLUTE_MEDIA_RE = /(!\[([^\]]*)\]\(\s*<?|<(img|video|source)\b[^>]*?\ssrc=["'])(https:\/\/[^\s)"'<>]+)/gi;
const CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*`+/g;

const GITHUB_COM = 'github.com';
const RAW_GITHUB_COM = 'raw.githubusercontent.com';

const SERVED_IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|avif)$/i;

type ProjectUploadUrls = {
    media: (path: string) => string;
    link: (path: string) => string;
    absolute?: (url: URL, video: boolean) => string | null;
};

const hostOf = (instance: string): string => instance.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

const mediaFilename = (url: URL): string => {
    const encoded = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    try {
        return decodeURIComponent(encoded) || 'image';
    } catch {
        return encoded || 'image';
    }
};

const base64Url = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const gitHubMediaPath = (url: URL, video: boolean, instance: string, project: RepositoryReference['sourceRepo']): string | null => {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (isRelayModeActive() && (video || isVideoSource(url.toString()))) return null;
    const host = hostOf(instance);
    const urlHost = url.hostname.toLowerCase();
    const ownFile = (owner: string | undefined, repo: string | undefined) => Boolean(owner && repo
        && sameName(owner, project.owner) && sameName(repo, project.repo) && SERVED_IMAGE_EXTENSION_RE.test(url.pathname));
    const attachment = /^\/user-attachments\/assets\/[\w-]+\/?$/.test(url.pathname);
    const blob = /^\/([^/]+)\/([^/]+)\/(blob|raw)\/.+$/.exec(url.pathname);
    const repositoryFile = Boolean(blob && (blob[3] === 'raw' || url.searchParams.get('raw') === 'true') && ownFile(blob[1], blob[2]));
    const rawFile = /^\/([^/]+)\/([^/]+)\/.+$/.exec(url.pathname);
    const supported = (urlHost === (host === GITHUB_COM ? GITHUB_COM : host) && (attachment || repositoryFile))
        || (host === GITHUB_COM && urlHost === RAW_GITHUB_COM && Boolean(rawFile) && ownFile(rawFile?.[1], rawFile?.[2]));
    if (!supported) return null;
    return `/uploads/${base64Url(url.toString())}/${encodeURIComponent(mediaFilename(url))}`;
};

export const rewriteProjectUploads = (markdown: string, urls: ProjectUploadUrls): string => {
    const rewrite = (text: string) => {
        const absolute = urls.absolute;
        if (!absolute) {
            return text
                .replace(MEDIA_UPLOAD_RE, (_match, lead: string, path: string) => `${lead}${urls.media(path)}`)
                .replace(LINKED_UPLOAD_RE, (_match, lead: string, path: string) => `${lead}${urls.link(path)}`);
        }
        return text.replace(ABSOLUTE_MEDIA_RE, (match, lead: string, alt: string | undefined, tag: string | undefined, source: string) => {
            let url: URL;
            try {
                url = new URL(source);
            } catch {
                return match;
            }
            const path = absolute(url, tag === undefined ? isVideoSource(source, alt ?? '') : tag.toLowerCase() !== 'img');
            return path ? `${lead}${urls.media(path)}` : match;
        });
    };
    let result = '';
    let last = 0;
    for (const code of markdown.matchAll(CODE_RE)) {
        result += rewrite(markdown.slice(last, code.index)) + code[0];
        last = code.index + code[0].length;
    }
    return result + rewrite(markdown.slice(last));
};

export const uploadUrls = (
    context: SourceControlReadContext,
    project: RepositoryReference['sourceRepo'],
    absoluteProjectUploads = false,
): ProjectUploadUrls => {
    const link = (path: string) => new URL(`${joinProjectPath(project.owner, project.repo)}${path}`, `${context.instance.replace(/\/+$/, '')}/`).toString();
    const route = (path: string) => `/api/source-control/${encodeURIComponent(context.provider)}${path}`;
    const query = {
        instance: context.instance,
        directory: context.directory,
        repositoryId: context.repositoryId,
        accountId: context.accountId,
        bindingRevision: context.bindingRevision,
        primaryRemote: context.primaryRemote,
        linked: context.linked ? '1' : undefined,
        owner: project.owner,
        repo: project.repo,
    };
    return {
        media: (path) => {
            if (isRelayModeActive()) {
                if (isVideoSource(path)) return link(path);
                const asset = new URL(route(path), 'http://openchamber.local');
                for (const [key, value] of Object.entries(query)) asset.searchParams.set(key, String(value));
                return `${asset.pathname}${asset.search}`;
            }
            return new URL(getRuntimeUrlResolver().authenticatedAsset(route(path), query), window.location.href).toString();
        },
        link,
        absolute: absoluteProjectUploads ? (url, video) => gitHubMediaPath(url, video, context.instance, project) : undefined,
    };
};

export function useProjectUploadRewrite(directory: string | null, reference: RepositoryReference | null): ((markdown: string) => string) | null {
    const provider = useSourceControlProvider(reference?.provider);
    const uploads = provider.features.projectUploads;
    const absoluteUploads = provider.features.absoluteProjectUploads;
    const bound = useRepositoryReadContext(uploads ? directory : null);
    const linked = reference?.linked === true;
    const context = React.useMemo(() => (bound && bound !== 'missing' && linked ? { ...bound, linked: true as const } : bound), [bound, linked]);
    const [tokenChecked, setTokenChecked] = React.useState(false);
    React.useEffect(() => {
        if (!uploads) return undefined;
        let live = true;
        const release = acquireRuntimeUrlAuthToken();
        void refreshRuntimeUrlAuthToken().catch(() => undefined).finally(() => {
            if (live) setTokenChecked(true);
        });
        return () => {
            live = false;
            release();
        };
    }, [uploads]);
    const project = reference?.sourceRepo;
    return React.useMemo(() => {
        if (!uploads || !project || !context || context === 'missing' || context.provider !== reference?.provider || !tokenChecked) return null;
        const urls = uploadUrls(context, project, absoluteUploads);
        return (markdown: string) => rewriteProjectUploads(markdown, urls);
    }, [absoluteUploads, context, project, reference?.provider, tokenChecked, uploads]);
}

export const ReferenceMarkdownRewriteContext = React.createContext<((markdown: string) => string) | null>(null);
