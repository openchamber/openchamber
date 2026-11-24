import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { useI18n } from '@/lib/i18n';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { SpaceChatPlaceholder } from '@/components/session/spaces/SpaceChatPlaceholder';
import { DraftWelcome } from './DraftWelcome';
import { HydrationSkeleton } from './HydrationSkeleton';
import { CHAT_SCROLL_STYLE } from './chatScrollStyle';

type TranslateFn = ReturnType<typeof useI18n>['t'];

export const resolveSessionPlaceholder = ({
    t,
    draftOpen,
    draftPresentationExiting,
    useCompactDraftLayout,
    isDesktopExpandedInput,
    isSessionHydrating,
    messageCount,
    sessionIsWorking,
    spaceStopped,
    effectiveSessionDirectory,
    loadStatus,
    authSessionExpired,
    retrySessionLoad,
}: {
    t: TranslateFn;
    draftOpen: boolean;
    draftPresentationExiting: boolean;
    useCompactDraftLayout: boolean;
    isDesktopExpandedInput: boolean;
    isSessionHydrating: boolean;
    messageCount: number;
    sessionIsWorking: boolean;
    spaceStopped: boolean;
    effectiveSessionDirectory: string | undefined;
    loadStatus: string;
    authSessionExpired: boolean;
    retrySessionLoad: () => void;
}): React.ReactNode => {
    if (draftOpen || draftPresentationExiting) {
        if (!useCompactDraftLayout || isDesktopExpandedInput) {
            return null;
        }
        return <DraftWelcome exiting={draftPresentationExiting} />;
    }

    const showHydrationSkeleton = isSessionHydrating && !sessionIsWorking && (messageCount === 0 || loadStatus === 'error');
    if (showHydrationSkeleton) {
        if (spaceStopped && effectiveSessionDirectory) {
            return <SpaceChatPlaceholder directory={effectiveSessionDirectory} />;
        }
        if (loadStatus === 'error') {
            return (
                <div className="flex min-h-0 flex-1 items-center justify-center px-6">
                    <div className="max-w-sm text-center">
                        <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] text-[var(--status-error)]">
                            <Icon name="error-warning" className="size-4" />
                        </div>
                        <p className="typography-ui-label font-medium text-foreground">{t('chat.container.sessionLoadError.title')}</p>
                        <p className="typography-meta mt-1 text-muted-foreground">
                            {authSessionExpired
                                ? t('chat.container.sessionLoadError.authDescription')
                                : t('chat.container.sessionLoadError.description')}
                        </p>
                        {authSessionExpired ? (
                            <Button variant="outline" size="sm" className="mt-4" onClick={() => useAuthSessionStore.getState().markReauthenticating()}>
                                {t('sessionAuth.expired.loginAction')}
                            </Button>
                        ) : (
                            <Button variant="outline" size="sm" className="mt-4" onClick={retrySessionLoad}>
                                {t('chat.container.sessionLoadError.retry')}
                            </Button>
                        )}
                    </div>
                </div>
            );
        }

        return (
            <div
                data-chat-hydration-skeleton=""
                className={cn(
                    'relative min-h-0',
                    isDesktopExpandedInput ? 'pointer-events-none absolute inset-0 opacity-0' : 'flex-1',
                )}
                aria-hidden={isDesktopExpandedInput}
            >
                <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background pt-6" style={CHAT_SCROLL_STYLE}>
                    <HydrationSkeleton waiting={!isDesktopExpandedInput} />
                </div>
            </div>
        );
    }

    if (messageCount === 0 && !sessionIsWorking) {
        return (
            <div
                className={cn(
                    'relative min-h-0',
                    isDesktopExpandedInput ? 'pointer-events-none absolute inset-0 opacity-0' : 'flex-1',
                )}
                aria-hidden={isDesktopExpandedInput}
            />
        );
    }

    return undefined;
};
