import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { providerLogoIds, useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';
import { useUIStore } from '@/stores/useUIStore';
import { customProviderIconName } from '@/lib/customProviderIcons';
import { providerLogoUploadSupported, useUploadedProviderLogoUrl } from '@/lib/customProviderLogos';
import { useGuestProviderLogo, useGuestProviderLogoUrl } from '@/lib/guests/provider-logos';
import type { RuntimeObjectUrl } from '@/lib/runtimeObjectUrl';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
    /** Show the provider's own logo even when the user uploaded a logo or picked an icon for it. */
    ignoreCustomIcon?: boolean;
    /** Shown when this provider has no chosen icon and no logo. `null` shows nothing. */
    fallback?: React.ReactNode;
    /**
     * Draw the app's monochrome logo in the text colour (a mask), so a caller
     * can mute it like an icon. Uploaded and extension logos keep their colours.
     */
    tint?: boolean;
}

const NO_URLS: ReadonlySet<string> = new Set();

/**
 * A provider's mark, first match wins: the logo the user uploaded, the icon
 * they picked, an active extension's logo, the bundled logo, the models.dev
 * logo, the generic fallback.
 */
export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError,
    ignoreCustomIcon = false,
    fallback,
    tint = false,
}) => {
    const { src, onError: handleInternalError, hasLogo, isBundled } = useProviderLogo(providerId);
    const customIcon = useUIStore((state) => state.customProviderIcons[providerId]);
    const storedLogo = useUIStore((state) => state.customProviderLogos[providerId]);
    const wantsUploadedLogo = Boolean(storedLogo) && !ignoreCustomIcon && providerLogoUploadSupported();
    const themeVariant = useOptionalThemeSystem()?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
    const uploadedLogo = useUploadedProviderLogoUrl(providerId, wantsUploadedLogo ? storedLogo : undefined, themeVariant);
    // Images the browser fetched but cannot draw (an SVG without its namespace).
    const [undrawableUrls, setUndrawableUrls] = React.useState(NO_URLS);
    const standsIn = (image: RuntimeObjectUrl) => !image.failed && !(image.url && undrawableUrls.has(image.url));
    const showsUpload = wantsUploadedLogo && standsIn(uploadedLogo);
    const chosenIcon = ignoreCustomIcon ? undefined : customIcon;
    const guestLogo = useGuestProviderLogo(providerLogoIds(providerId));
    const wantsGuestLogo = guestLogo !== null && !showsUpload && !chosenIcon;
    const guestLogoUrl = useGuestProviderLogoUrl(wantsGuestLogo ? guestLogo : null, themeVariant);
    const fallbackIcon = getProviderLogoFallbackIcon(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    // An upload or an extension's logo keeps its own colours; only the app's
    // monochrome logos below are inverted. Holds its place while it loads, and
    // a failed fetch or draw falls through to the next mark.
    const drawnImage = (url: string) => (
        <img
            src={url}
            alt={alt ?? `${providerId} logo`}
            aria-hidden={alt === '' ? true : undefined}
            className={cn('object-contain', className)}
            draggable={false}
            onError={() => setUndrawableUrls((urls) => new Set(urls).add(url))}
        />
    );
    const slot = <span aria-hidden className={cn('inline-block', className)} />;

    if (showsUpload) return uploadedLogo.url ? drawnImage(uploadedLogo.url) : slot;

    if (chosenIcon) {
        return <Icon name={customProviderIconName(chosenIcon)} className={cn('text-muted-foreground', className)} />;
    }

    if (wantsGuestLogo && standsIn(guestLogoUrl)) {
        if (guestLogoUrl.url) return drawnImage(guestLogoUrl.url);
        // A bundled logo costs no request, so it stays until this one arrives; a models.dev one would be fetched for nothing.
        if (!isBundled) return slot;
    }

    if (!hasLogo || !src) {
        if (fallback !== undefined) return <>{fallback}</>;
        return fallbackIcon ? <Icon name={fallbackIcon} className={cn('text-muted-foreground', className)} /> : null;
    }

    if (tint) {
        // The logo's shape in the current text colour, for any theme. A mask
        // reports no load failure, so a hidden image of the same file still
        // does, and a logo that fails falls back as an untinted one would.
        // A mask is fetched in CORS mode; the image asks the same way, so the
        // two share one request instead of fetching the file twice.
        return (
            <>
            <img src={src} alt="" aria-hidden hidden crossOrigin="anonymous" onError={handleError} />
            <span
                role={alt === '' ? undefined : 'img'}
                aria-label={alt === '' ? undefined : alt ?? `${providerId} logo`}
                aria-hidden={alt === '' ? true : undefined}
                className={cn('inline-block bg-current', className)}
                style={{
                    maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`,
                    maskSize: 'contain', WebkitMaskSize: 'contain',
                    maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
                    maskPosition: 'center', WebkitMaskPosition: 'center',
                }}
            />
            </>
        );
    }

    return (
        <img
            src={src}
            alt={alt ?? `${providerId} logo`}
            aria-hidden={alt === '' ? true : undefined}
            className={cn('dark:invert object-contain', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onError={handleError}
        />
    );
};
