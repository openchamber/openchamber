import React from 'react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';

const ChatEmptyState: React.FC = () => {
    const { currentTheme } = useThemeSystem();

    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <OpenChamberLogo width={140} height={140} className="opacity-20" />
            <span className="text-body-md" style={{ color: textColor }}>Start a new chat</span>
        </div>
    );
};

export default React.memo(ChatEmptyState);
