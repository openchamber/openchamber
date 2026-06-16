import { useState, useCallback, useEffect, useMemo } from 'react';
import type { ProviderIconImage } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { useProviderIconStore } from '@/stores/useProviderIconStore';

type LogoSource = 'local' | 'remote' | 'none';

interface UseProviderLogoReturn {
    src: string | null;
    onError: () => void;
    hasLogo: boolean;
    isCustom: boolean;
}

const localLogoModules = import.meta.glob<string>('../assets/provider-logos/*.svg', {
    eager: true,
    import: 'default',
});

const LOCAL_PROVIDER_LOGO_MAP = new Map<string, string>();
const PRELOADED_LOGO_SRCS = new Set<string>();
const PROVIDER_ICON_OBJECT_URL_CACHE_LIMIT = 120;
const HIDDEN_PROVIDER_LOGO_OPTION_IDS = new Set(['zai-coding-plan']);

type ProviderIconObjectUrlCacheEntry = {
    url?: string;
    promise?: Promise<string | null>;
};

type ProviderIconObjectUrlRequest = {
    cacheKey: string;
    providerId: string;
    updatedAt: number;
};

export type ProviderLogoOption = {
    id: string;
    src: string;
    label: string;
};

const providerIconObjectUrlCache = new Map<string, ProviderIconObjectUrlCacheEntry>();

const LOGO_ALIAS = new Map<string, string>([
    ['codex', 'openai'],
    ['chatgpt', 'openai'],
    ['claude', 'anthropic'],
    ['gemini', 'google'],
    ['evroc-ai', 'evroc'],
    ['evrocai', 'evroc'],
    ['ollama-cloud', 'ollama'],
    ['wafer-ai', 'wafer.ai'],
    ['wafer', 'wafer.ai'],
]);

const normalizeProviderId = (providerId: string | null | undefined) => {
    return (providerId ?? '')
        .toLowerCase()
        .trim()
        .replace(/^models\./, '')
        .replace(/^provider\./, '')
        .replace(/\s+/g, '-');
};

const buildLogoCandidates = (providerId: string | null | undefined) => {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) {
        return [] as string[];
    }

    const compact = normalized.replace(/[^a-z0-9_\-./:]/g, '');
    const primary = compact.split(/[/:]/)[0] || compact;
    const candidates = [LOGO_ALIAS.get(compact), LOGO_ALIAS.get(primary), compact, primary]
        .filter((value): value is string => Boolean(value && value.length > 0));

    return [...new Set(candidates)];
};

const buildProviderIconObjectUrlRequest = (
    providerId: string,
    iconImage: ProviderIconImage | undefined,
): ProviderIconObjectUrlRequest | null => {
    const normalizedProviderId = providerId.trim();
    const updatedAt = iconImage?.updatedAt;
    if (
        iconImage?.source !== 'custom' ||
        !normalizedProviderId ||
        typeof updatedAt !== 'number' ||
        updatedAt <= 0 ||
        isVSCodeRuntime()
    ) {
        return null;
    }

    return {
        cacheKey: [
            getRuntimeApiBaseUrl() || 'same-origin',
            normalizedProviderId,
            String(updatedAt),
        ].join('|'),
        providerId: normalizedProviderId,
        updatedAt,
    };
};

const trimProviderIconObjectUrlCache = (): void => {
    while (providerIconObjectUrlCache.size > PROVIDER_ICON_OBJECT_URL_CACHE_LIMIT) {
        const firstKey = providerIconObjectUrlCache.keys().next().value;
        if (typeof firstKey !== 'string') return;
        const entry = providerIconObjectUrlCache.get(firstKey);
        if (entry?.url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(entry.url);
        }
        providerIconObjectUrlCache.delete(firstKey);
    }
};

const loadProviderIconObjectUrl = (
    request: ProviderIconObjectUrlRequest,
): Promise<string | null> => {
    const cached = providerIconObjectUrlCache.get(request.cacheKey);
    if (cached?.url) return Promise.resolve(cached.url);
    if (cached?.promise) return cached.promise;

    const promise = runtimeFetch(`/api/provider/${encodeURIComponent(request.providerId)}/icon`, {
        method: 'GET',
        headers: { Accept: 'image/*' },
        query: new URLSearchParams({ v: String(request.updatedAt) }),
    })
        .then(async (response) => {
            if (!response.ok) return null;
            if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            providerIconObjectUrlCache.set(request.cacheKey, { url });
            trimProviderIconObjectUrlCache();
            return url;
        })
        .catch(() => null)
        .finally(() => {
            const entry = providerIconObjectUrlCache.get(request.cacheKey);
            if (entry?.promise === promise && !entry.url) {
                providerIconObjectUrlCache.delete(request.cacheKey);
            }
        });

    providerIconObjectUrlCache.set(request.cacheKey, { promise });
    return promise;
};

const useProviderIconImageObjectUrl = (
    providerId: string,
    iconImage: ProviderIconImage | undefined,
): string | null => {
    const request = useMemo(
        () => buildProviderIconObjectUrlRequest(providerId, iconImage),
        [providerId, iconImage],
    );
    const [url, setUrl] = useState(() => {
        return request ? providerIconObjectUrlCache.get(request.cacheKey)?.url ?? null : null;
    });

    useEffect(() => {
        if (!request) {
            setUrl(null);
            return;
        }

        const cached = providerIconObjectUrlCache.get(request.cacheKey)?.url;
        if (cached) {
            setUrl(cached);
            return;
        }

        let cancelled = false;
        setUrl(null);
        void loadProviderIconObjectUrl(request).then((nextUrl) => {
            if (!cancelled) setUrl(nextUrl);
        });

        return () => {
            cancelled = true;
        };
    }, [request]);

    return url;
};

const resolveProviderLogoSrc = (providerId: string | null | undefined): string | null => {
    const candidates = buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const localLogoSrc = localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;
    if (localLogoSrc) {
        return localLogoSrc;
    }

    const remoteResolvedId = candidates[0] ?? null;
    return remoteResolvedId ? `https://models.dev/logos/${remoteResolvedId}.svg` : null;
};

export const preloadProviderLogo = (providerId: string | null | undefined): void => {
    if (typeof Image === 'undefined') return;
    const src = resolveProviderLogoSrc(providerId);
    if (!src || PRELOADED_LOGO_SRCS.has(src)) return;

    PRELOADED_LOGO_SRCS.add(src);
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => {
        PRELOADED_LOGO_SRCS.delete(src);
    };
    image.src = src;
    void image.decode?.().catch(() => undefined);
};

export const preloadProviderLogos = (providerIds: readonly (string | null | undefined)[]): void => {
    for (const providerId of providerIds) {
        preloadProviderLogo(providerId);
    }
};

for (const [path, url] of Object.entries(localLogoModules)) {
    const match = path.match(/provider-logos\/([^/]+)\.svg$/i);
    if (match?.[1] && url) {
        LOCAL_PROVIDER_LOGO_MAP.set(match[1].toLowerCase(), url);
    }
}

const formatProviderLogoOptionLabel = (id: string): string => (
    id
        .split(/[-_.]+/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
);

export const PROVIDER_LOGO_OPTIONS: ProviderLogoOption[] = Array.from(LOCAL_PROVIDER_LOGO_MAP.entries())
    .filter(([id]) => !HIDDEN_PROVIDER_LOGO_OPTION_IDS.has(id))
    .map(([id, src]) => ({ id, src, label: formatProviderLogoOptionLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

export function useProviderLogo(providerId: string | null | undefined): UseProviderLogoReturn {
    const rawProviderId = (providerId ?? '').trim();
    const providerIconImage = useProviderIconStore((state) => rawProviderId ? state.providerIconImages[rawProviderId] : undefined);
    const loadProviderIcons = useProviderIconStore((state) => state.loadProviderIcons);
    const customLogoSrc = useProviderIconImageObjectUrl(rawProviderId, providerIconImage);
    const builtInProviderId = providerIconImage?.source === 'builtin' ? providerIconImage.builtinProviderId : undefined;
    const builtInLogoSrc = builtInProviderId ? resolveProviderLogoSrc(builtInProviderId) : null;
    const candidates = buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const remoteResolvedId = candidates[0] ?? null;
    const hasLocalLogo = Boolean(localResolvedId);
    const localLogoSrc = localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;

    const [source, setSource] = useState<LogoSource>(hasLocalLogo ? 'local' : 'remote');
    const [customFailed, setCustomFailed] = useState(false);
    const [builtInFailed, setBuiltInFailed] = useState(false);

    useEffect(() => {
        void loadProviderIcons();
    }, [loadProviderIcons]);

    useEffect(() => {
        setCustomFailed(false);
    }, [rawProviderId, providerIconImage?.updatedAt]);

    useEffect(() => {
        setBuiltInFailed(false);
    }, [rawProviderId, builtInProviderId, providerIconImage?.updatedAt]);

    useEffect(() => {
        setSource(hasLocalLogo ? 'local' : 'remote');
    }, [hasLocalLogo, localResolvedId, remoteResolvedId]);

    const handleError = useCallback(() => {
        if (customLogoSrc && !customFailed) {
            setCustomFailed(true);
            return;
        }
        if (builtInLogoSrc && !builtInFailed) {
            setBuiltInFailed(true);
            return;
        }
        setSource((current) => (current === 'local' && hasLocalLogo ? 'remote' : 'none'));
    }, [builtInFailed, builtInLogoSrc, customFailed, customLogoSrc, hasLocalLogo]);

    if (customLogoSrc && !customFailed) {
        return {
            src: customLogoSrc,
            onError: handleError,
            hasLogo: true,
            isCustom: true,
        };
    }

    if (builtInLogoSrc && !builtInFailed) {
        return {
            src: builtInLogoSrc,
            onError: handleError,
            hasLogo: true,
            isCustom: false,
        };
    }

    if (!localResolvedId && !remoteResolvedId) {
        return { src: null, onError: handleError, hasLogo: false, isCustom: false };
    }

    if (source === 'local' && localLogoSrc) {
        return {
            src: localLogoSrc,
            onError: handleError,
            hasLogo: true,
            isCustom: false,
        };
    }

    if (source === 'remote' && remoteResolvedId) {
        return {
            src: `https://models.dev/logos/${remoteResolvedId}.svg`,
            onError: handleError,
            hasLogo: true,
            isCustom: false,
        };
    }

    return { src: null, onError: handleError, hasLogo: false, isCustom: false };
}
