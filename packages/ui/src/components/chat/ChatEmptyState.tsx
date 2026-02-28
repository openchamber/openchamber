import React from 'react';
import { RiGitBranchLine } from '@remixicon/react';

import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { TextLoop } from '@/components/ui/TextLoop';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useLanguage } from '@/hooks/useLanguage';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';

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

interface ChatEmptyStateProps {
    showDraftContext?: boolean;
}

const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
    showDraftContext = false,
}) => {
    const { t } = useLanguage();
    const { currentTheme } = useThemeSystem();
    const { git } = useRuntimeAPIs();
    const effectiveDirectory = useEffectiveDirectory();
    const { setActiveDirectory, fetchStatus } = useGitStore();
    const gitStatus = useGitStatus(effectiveDirectory ?? null);

    // Use theme's muted foreground for secondary text
    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';
    const branchName = typeof gitStatus?.current === 'string' && gitStatus.current.trim().length > 0
        ? gitStatus.current.trim()
        : null;

    React.useEffect(() => {
        if (!showDraftContext || !effectiveDirectory) {
            return;
        }

        setActiveDirectory(effectiveDirectory);

        const state = useGitStore.getState().directories.get(effectiveDirectory);
        if (!state?.status && state?.isGitRepo !== false) {
            void fetchStatus(effectiveDirectory, git, { silent: true });
        }
    }, [effectiveDirectory, fetchStatus, git, setActiveDirectory, showDraftContext]);

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <OpenChamberLogo width={140} height={140} className="opacity-20" isAnimated />
            {showDraftContext && (
                <div className="max-w-[calc(100%-2rem)] flex flex-col items-center gap-1">
                    {branchName && (
                        <div className="inline-flex items-center gap-1 text-body-md" style={{ color: textColor }}>
                            <RiGitBranchLine className="h-4 w-4 shrink-0" />
                            <span className="overflow-hidden whitespace-nowrap" title={branchName}>{branchName}</span>
                        </div>
                    )}
                </div>
            )}
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
