import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n, getCurrentIntlLocale } from '@/lib/i18n';
import type { WebSearchOutput, WebSearchResult } from '@/lib/opencode/websearch';
import { openExternalUrl } from '@/lib/url';
import { useWebSearchStore } from '@/stores/useWebSearchStore';

/**
 * A finished `websearch` call as a list of result cards: site icon and
 * domain, the title linking out, the publish date, and a clamped snippet.
 * Parsing lives in `@/lib/opencode/websearch`; a result it cannot read keeps
 * the plain text renderer.
 */

const formatPublished = (iso: string): string | null => {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleDateString(getCurrentIntlLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
};

const originOf = (url: string): string | null => {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
};

// The site's own icon, fetched from the site itself (no third-party icon
// service sees the domain); the globe stands in when it has none.
const SiteIcon: React.FC<{ url: string }> = ({ url }) => {
    const origin = originOf(url);
    const [failed, setFailed] = React.useState(false);
    if (!origin || failed) {
        return <Icon name="global" className="size-3.5 text-muted-foreground" />;
    }
    return (
        <img
            src={`${origin}/favicon.ico`}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-3.5 rounded-sm"
            onError={() => setFailed(true)}
        />
    );
};

const ResultCard: React.FC<{ result: WebSearchResult }> = ({ result }) => {
    const published = result.published ? formatPublished(result.published) : null;
    const snippet = result.snippet?.replace(/\s+/g, ' ').trim() ?? '';

    // Plain primary clicks open the page the same way chat links do (system
    // browser on desktop and VS Code); modified clicks keep the browser default.
    const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        void openExternalUrl(result.url);
    };

    return (
        <li>
            <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleClick}
                className="group flex min-w-0 gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-interactive-hover/30"
            >
                <span className="mt-1 flex size-3.5 shrink-0 items-center justify-center">
                    <SiteIcon url={result.url} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate typography-meta font-medium text-foreground group-hover:underline">
                        {result.title ?? result.host}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
                        <span className="truncate">{result.host}</span>
                        {published ? <span className="shrink-0 tabular-nums">{published}</span> : null}
                    </span>
                    {snippet ? (
                        <span className="mt-0.5 line-clamp-2 break-words typography-meta text-muted-foreground">{snippet}</span>
                    ) : null}
                </span>
            </a>
        </li>
    );
};

export const WebSearchResults: React.FC<{ output: WebSearchOutput; providerId: string | null }> = ({ output, providerId }) => {
    const { t } = useI18n();
    // Name the provider when Settings already read the list; the id otherwise.
    const providerName = useWebSearchStore((store) => {
        if (!providerId) return null;
        const state = store.state;
        if (state.kind !== 'ready') return providerId;
        return state.snapshot.providers.find((provider) => provider.id === providerId)?.name ?? providerId;
    });

    return (
        <div className="w-full min-w-0 space-y-1">
            {output.kind === 'empty' ? (
                <div className="px-2 typography-meta text-muted-foreground">{t('chat.webSearch.noResults')}</div>
            ) : (
                <ul className="space-y-0.5">
                    {output.results.map((result, index) => (
                        <ResultCard key={`${index}:${result.url}`} result={result} />
                    ))}
                </ul>
            )}
            {providerName ? (
                <div className="px-2 typography-micro text-muted-foreground/80">
                    {t('chat.webSearch.provider', { provider: providerName })}
                </div>
            ) : null}
        </div>
    );
};
