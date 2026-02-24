import { useState, useCallback, useEffect } from 'react';

type LogoSource = 'local' | 'remote' | 'none';

interface UseProviderLogoReturn {
    src: string | null;
    onError: () => void;
    hasLogo: boolean;
}

const localLogoModules = import.meta.glob<string>('../assets/provider-logos/*.svg', {
    eager: true,
    import: 'default',
});

const LOCAL_PROVIDER_LOGO_MAP = new Map<string, string>();

const LOGO_ALIAS = new Map<string, string>([
    ['codex', 'openai'],
    ['chatgpt', 'openai'],
    ['claude', 'anthropic'],
    ['gemini', 'google'],
    ['evroc-ai', 'evroc'],
    ['evrocai', 'evroc'],
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
    const candidates = [compact, primary, LOGO_ALIAS.get(compact), LOGO_ALIAS.get(primary)]
        .filter((value): value is string => Boolean(value && value.length > 0));

    return [...new Set(candidates)];
};

for (const [path, url] of Object.entries(localLogoModules)) {
    const match = path.match(/provider-logos\/([^/]+)\.svg$/i);
    if (match?.[1] && url) {
        LOCAL_PROVIDER_LOGO_MAP.set(match[1].toLowerCase(), url);
    }
}

export function useProviderLogo(providerId: string | null | undefined): UseProviderLogoReturn {
    const candidates = buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const remoteResolvedId = candidates[0] ?? null;
    const hasLocalLogo = Boolean(localResolvedId);
    const localLogoSrc = localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;

    const [source, setSource] = useState<LogoSource>(hasLocalLogo ? 'local' : 'remote');

    useEffect(() => {
        setSource(hasLocalLogo ? 'local' : 'remote');
    }, [hasLocalLogo, localResolvedId, remoteResolvedId]);

    const handleError = useCallback(() => {
        setSource((current) => (current === 'local' && hasLocalLogo ? 'remote' : 'none'));
    }, [hasLocalLogo]);

    if (!localResolvedId && !remoteResolvedId) {
        return { src: null, onError: handleError, hasLogo: false };
    }

    if (source === 'local' && localLogoSrc) {
        return {
            src: localLogoSrc,
            onError: handleError,
            hasLogo: true,
        };
    }

    if (source === 'remote' && remoteResolvedId) {
        return {
            src: `https://models.dev/logos/${remoteResolvedId}.svg`,
            onError: handleError,
            hasLogo: true,
        };
    }

    return { src: null, onError: handleError, hasLogo: false };
}
