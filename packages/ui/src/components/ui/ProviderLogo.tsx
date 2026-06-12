import React from 'react';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    fallback?: React.ReactNode;
    onError?: () => void;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    fallback = null,
    onError: externalOnError
}) => {
    const { src, onError: handleInternalError, hasLogo, isCustom } = useProviderLogo(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (!hasLogo || !src) {
        return <>{fallback}</>;
    }

    return (
        <img
            src={src}
            alt={alt || `${providerId} logo`}
            className={cn(isCustom ? 'object-contain' : 'dark:invert object-contain', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            onError={handleError}
        />
    );
};
