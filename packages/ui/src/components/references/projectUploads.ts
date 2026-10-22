/**
 * Files attached to a project on a provider that writes them as a path on the
 * project, `/uploads/<secret>/<name>` (`features.projectUploads`, GitLab). The
 * browser would resolve that path against this app, and only a signed-in
 * member may read it. For display a picture or a clip goes through the
 * server's uploads route of the provider, and a link to any other file goes to
 * the file on the host, where the user is signed in. Code keeps the path as
 * written, and the text attached for the agent is not rewritten at all.
 */
import * as React from 'react';

import type { RepositoryReference } from '@/lib/api/types';
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { SourceControlReadContext } from '@/lib/source-control/types';

import { useRepositoryReadContext } from './referenceSources';

const UPLOAD_PATH = String.raw`\/uploads\/[0-9a-f]{32}\/[^\s)"'<>]+`;
// An image destination or an HTML `src`: drawn here, so read through the server.
const MEDIA_UPLOAD_RE = new RegExp(String.raw`(!\[[^\]]*\]\(\s*<?|\bsrc=["'])(${UPLOAD_PATH})`, 'g');
// Any other destination or `href`: a file to open on the host.
const LINKED_UPLOAD_RE = new RegExp(String.raw`(\]\(\s*<?|\bhref=["'])(${UPLOAD_PATH})`, 'g');
// Fenced blocks and code spans, which show their text as written.
const CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*`+/g;

type ProjectUploadUrls = {
    /** Where a drawn picture or clip is read from. */
    media: (path: string) => string;
    /** Where a link to an attached file opens. */
    link: (path: string) => string;
};

/** The same Markdown with every upload path outside code pointed at `urls`. */
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

const uploadUrls = (context: SourceControlReadContext, project: RepositoryReference['sourceRepo']): ProjectUploadUrls => ({
    // Signed with the token current at the time, so every item read later
    // gets a fresh one; a clip whose token expired retries (markdownVideo.ts).
    media: (path) => new URL(getRuntimeUrlResolver().authenticatedAsset(`/api/source-control/${encodeURIComponent(context.provider)}${path}`, {
        instance: context.instance,
        directory: context.directory,
        repositoryId: context.repositoryId,
        accountId: context.accountId,
        bindingRevision: context.bindingRevision,
        primaryRemote: context.primaryRemote,
        owner: project.owner,
        repo: project.repo,
    }), window.location.href).toString(),
    link: (path) => new URL(`${project.owner}/${project.repo}${path}`, `${context.instance.replace(/\/+$/, '')}/`).toString(),
});

/**
 * How an item's description and notes read for display, or null when nothing
 * needs rewriting (its provider has no project uploads, or the read context is
 * not known yet).
 */
export function useProjectUploadRewrite(directory: string | null, reference: RepositoryReference | null): ((markdown: string) => string) | null {
    const uploads = useSourceControlProvider(reference?.provider).features.projectUploads;
    const context = useRepositoryReadContext(uploads ? directory : null);
    // `img` and `video` cannot send headers, so the address carries the URL
    // token. It is kept fresh while such an item is shown; without one the
    // cookie authenticates, so a failed mint still renders.
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

/** The rewrite every Markdown body inside a preview applies; none outside one. */
export const ReferenceMarkdownRewriteContext = React.createContext<((markdown: string) => string) | null>(null);
