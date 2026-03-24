import React from 'react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { TextLoop } from '@/components/ui/TextLoop';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useLanguage } from '@/hooks/useLanguage';

const phraseKeys = [
    'chatEmptyState.phrases.fixFailingTests',
    'chatEmptyState.phrases.refactorReadable',
    'chatEmptyState.phrases.addFormValidation',
    'chatEmptyState.phrases.optimizeFunction',
    'chatEmptyState.phrases.writeTests',
    'chatEmptyState.phrases.explainHowWorks',
    'chatEmptyState.phrases.addFeature',
    'chatEmptyState.phrases.helpDebug',
    'chatEmptyState.phrases.reviewCode',
    'chatEmptyState.phrases.simplifyLogic',
    'chatEmptyState.phrases.addErrorHandling',
    'chatEmptyState.phrases.createComponent',
    'chatEmptyState.phrases.updateDocs',
    'chatEmptyState.phrases.findBug',
    'chatEmptyState.phrases.improvePerformance',
    'chatEmptyState.phrases.addTypeDefinitions',
] as const;

const ChatEmptyState: React.FC = () => {
    const { t } = useLanguage();
    const { currentTheme } = useThemeSystem();

    // Use theme's muted foreground for secondary text
    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <OpenChamberLogo width={140} height={140} className="opacity-20" isAnimated />
            <TextLoop
                className="text-body-md"
                interval={4}
                transition={{ duration: 0.5 }}
            >
                {phraseKeys.map((phraseKey) => (
                    <span key={phraseKey} style={{ color: textColor }}>"{t(phraseKey)}…"</span>
                ))}
            </TextLoop>
        </div>
    );
};

export default React.memo(ChatEmptyState);
