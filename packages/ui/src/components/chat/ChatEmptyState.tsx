import React from 'react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { useI18n } from '@/lib/i18n';

const ChatEmptyState: React.FC = () => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const initError = useGlobalSyncStore((s) => s.error);

    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <OpenChamberLogo width={140} height={140} className="opacity-20" />
            {initError ? (
                <div className="flex flex-col items-center gap-2 max-w-md text-center px-4">
                    <span className="text-body-md font-medium text-destructive">{t('chat.emptyState.opencodeUnreachable')}</span>
                    <span className="text-body-sm" style={{ color: textColor }}>
                        {initError.message}
                    </span>
                </div>
            ) : (
                <span className="text-body-md" style={{ color: textColor }}>{t('chat.emptyState.startNewChat')}</span>
            )}
        </div>
    );
};

export default React.memo(ChatEmptyState);
