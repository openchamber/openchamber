import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';
import { useUIStore } from '@/stores/useUIStore';
import { customProviderIconName } from '@/lib/customProviderIcons';
import { providerLogoUploadSupported, useUploadedProviderLogoUrl } from '@/lib/customProviderLogos';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
    /** Show the provider's own logo even when the user uploaded a logo or picked an icon for it. */
    ignoreCustomIcon?: boolean;
    /** Shown when this provider has no chosen icon and no logo. `null` shows nothing. */
    fallback?: React.ReactNode;
}

/**
 * A provider's mark, first match wins: the logo the user uploaded, the icon
 * they picked, the bundled logo, the models.dev logo, the generic fallback.
 */
export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError,
    ignoreCustomIcon = false,
    fallback,
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const customIcon = useUIStore((state) => state.customProviderIcons[providerId]);
    const storedLogo = useUIStore((state) => state.customProviderLogos[providerId]);
    const wantsUploadedLogo = Boolean(storedLogo) && !ignoreCustomIcon && providerLogoUploadSupported();
    const themeVariant = useOptionalThemeSystem()?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
    const uploadedLogo = useUploadedProviderLogoUrl(providerId, wantsUploadedLogo ? storedLogo : undefined, themeVariant);
    // An upload the browser fetched but cannot draw (an SVG without its namespace).
    const [undrawableUrl, setUndrawableUrl] = React.useState<string | null>(null);
    const uploadedUrl = uploadedLogo.url !== undrawableUrl ? uploadedLogo.url : null;
    const fallbackIcon = getProviderLogoFallbackIcon(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (uploadedUrl) {
        // An upload keeps its own colours; only the monochrome logos below are inverted.
        return (
            <img
                src={uploadedUrl}
                alt={alt ?? `${providerId} logo`}
                aria-hidden={alt === '' ? true : undefined}
                className={cn('object-contain', className)}
                draggable={false}
                onError={() => setUndrawableUrl(uploadedUrl)}
            />
        );
    }
    // Holds the logo's place while it loads; a failed fetch or draw falls through.
    if (wantsUploadedLogo && !uploadedLogo.failed && uploadedLogo.url === null) {
        return <span aria-hidden className={cn('inline-block', className)} />;
    }

    if (customIcon && !ignoreCustomIcon) {
        return <Icon name={customProviderIconName(customIcon)} className={cn('text-muted-foreground', className)} />;
    }

    if (!hasLogo || !src) {
        if (fallback !== undefined) return <>{fallback}</>;
        return fallbackIcon ? <Icon name={fallbackIcon} className={cn('text-muted-foreground', className)} /> : null;
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
