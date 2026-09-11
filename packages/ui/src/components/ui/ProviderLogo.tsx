import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const fallbackIcon = getProviderLogoFallbackIcon(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (!hasLogo || !src) {
        return fallbackIcon ? <Icon name={fallbackIcon} className={cn('text-muted-foreground', className)} /> : null;
    }

    return (
        <img
            src={src}
            alt={alt || `${providerId} logo`}
            className={cn('dark:invert object-contain', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onError={handleError}
        />
    );
};
