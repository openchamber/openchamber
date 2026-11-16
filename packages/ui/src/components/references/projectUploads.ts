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
const CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*`+/g;

type ProjectUploadUrls = {
    media: (path: string) => string;
    link: (path: string) => string;
};

export const rewriteProjectUploads = (markdown: string, urls: ProjectUploadUrls): string => {
    const rewrite = (text: string) => text
        .replace(MEDIA_UPLOAD_RE, (_match, lead: string, path: string) => `${lead}${urls.media(path)}`)
        .replace(LINKED_UPLOAD_RE, (_match, lead: string, path: string) => `${lead}${urls.link(path)}`);
    let result = '';
    let last = 0;
    for (const code of markdown.matchAll(CODE_RE)) {
        result += rewrite(markdown.slice(last, code.index)) + code[0];
        last = code.index + code[0].length;
    }
    return result + rewrite(markdown.slice(last));
};

export const uploadUrls = (context: SourceControlReadContext, project: RepositoryReference['sourceRepo']): ProjectUploadUrls => {
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
    };
};

export function useProjectUploadRewrite(directory: string | null, reference: RepositoryReference | null): ((markdown: string) => string) | null {
    const uploads = useSourceControlProvider(reference?.provider).features.projectUploads;
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
        const urls = uploadUrls(context, project);
        return (markdown: string) => rewriteProjectUploads(markdown, urls);
    }, [context, project, reference?.provider, tokenChecked, uploads]);
}

export const ReferenceMarkdownRewriteContext = React.createContext<((markdown: string) => string) | null>(null);
