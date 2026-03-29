import React from 'react';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { TextLoop } from '@/components/ui/TextLoop';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useTranslation } from 'react-i18next';

const ChatEmptyState: React.FC = () => {
    const { t } = useTranslation();
    const { currentTheme } = useThemeSystem();
    const phrases = React.useMemo(() => ([
        t('chat.emptyStatePhrases.fixFailingTests'),
        t('chat.emptyStatePhrases.refactorReadable'),
        t('chat.emptyStatePhrases.addFormValidation'),
        t('chat.emptyStatePhrases.optimizeFunction'),
        t('chat.emptyStatePhrases.writeTests'),
        t('chat.emptyStatePhrases.explainHowItWorks'),
        t('chat.emptyStatePhrases.addFeature'),
        t('chat.emptyStatePhrases.helpDebug'),
        t('chat.emptyStatePhrases.reviewCode'),
        t('chat.emptyStatePhrases.simplifyLogic'),
        t('chat.emptyStatePhrases.addErrorHandling'),
        t('chat.emptyStatePhrases.createComponent'),
        t('chat.emptyStatePhrases.updateDocs'),
        t('chat.emptyStatePhrases.findBug'),
        t('chat.emptyStatePhrases.improvePerformance'),
        t('chat.emptyStatePhrases.addTypeDefinitions'),
    ]), [t]);

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
                {phrases.map((phrase) => (
                    <span key={phrase} style={{ color: textColor }}>"{phrase}…"</span>
                ))}
            </TextLoop>
        </div>
    );
};

export default React.memo(ChatEmptyState);
