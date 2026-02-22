import React from 'react';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';

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

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (!hasLogo || !src) {
        return null;
    }

    return (
        <img
            src={src}
            alt={alt || `${providerId} logo`}
            className={cn('dark:invert object-contain', className)}
            onError={handleError}
        />
    );
};
