import React from 'react';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';
import { AboutSettings } from './AboutSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { PasskeySettings } from './PasskeySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { GitHubSettings } from './GitHubSettings';
import { VoiceSettings } from './VoiceSettings';
import { TunnelSettings } from './TunnelSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import type { OpenChamberSection } from './types';

interface OpenChamberPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: OpenChamberSection;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({ section }) => {
    const { isMobile } = useDeviceInfo();
    const showAbout = isMobile && isWebRuntime();
    const isVSCode = isVSCodeRuntime();
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <ScrollableOverlay
                outerClassName="h-full"
                className="w-full"
            >
                <div className="openchamber-page-body mx-auto max-w-3xl space-y-3 p-3 sm:space-y-6 sm:p-6 sm:pt-8">
                    <OpenChamberVisualSettings />
                    <div className="border-t border-border/40 pt-6">
                        <DefaultsSettings />
                    </div>
                    {!isVSCode && (
                        <div className="border-t border-border/40 pt-6">
                            <OpenCodeCliSettings />
                        </div>
                    )}
                    {showDesktopNetworkSettings && (
                        <div className="border-t border-border/40 pt-6">
                            <DesktopNetworkSettings />
                        </div>
                    )}
                    <div className="border-t border-border/40 pt-6">
                        <SessionRetentionSettings />
                    </div>
                    <div className="border-t border-border/40 pt-6">
                        <PasskeySettings />
                    </div>
                    {showAbout && (
                        <div className="border-t border-border/40 pt-6">
                            <AboutSettings />
                        </div>
                    )}
                </div>
            </ScrollableOverlay>
        );
    }

    // Show specific section content
    const renderSectionContent = () => {
        switch (section) {
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'sessions':
                return <SessionsSectionContent />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'github':
                return <GitHubSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'voice':
                return <VoiceSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            default:
                return null;
        }
    };

    return (
        <ScrollableOverlay
            outerClassName="h-full"
            className="w-full"
        >
            <div className="openchamber-page-body mx-auto max-w-3xl space-y-6 p-3 sm:p-6 sm:pt-8">
                {renderSectionContent()}
            </div>
        </ScrollableOverlay>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return <KeyboardShortcutsSettings />;
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    return <OpenChamberVisualSettings visibleSettings={[
        'theme',
        'pwaInstallName',
        'pwaOrientation',
        'timeFormat',
        'weekStart',
        'fontSize',
        'terminalFontSize',
        'spacing',
        'inputBarOffset',
        ...(!isVSCode ? ['terminalQuickKeys' as const] : []),
        'reportUsage',
    ]} />;
};

// Chat section: User message rendering, Diff layout, Mobile status bar, Show reasoning traces, Queue mode, Persist draft
const ChatSectionContent: React.FC = () => {
    return <OpenChamberVisualSettings visibleSettings={['chatRenderMode', 'messageTransport', 'activityRenderMode', 'userMessageRendering', 'mermaidRendering', 'reasoning', 'showToolFileIcons', 'expandedTools', 'stickyUserHeader', 'wideChatLayout', 'splitAssistantMessageActions', 'diffLayout', 'mobileStatusBar', 'dotfiles', 'queueMode', 'persistDraft', 'inputSpellcheck']} />;
};

// Sessions section: Default model & agent, Session retention
const SessionsSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    return (
        <div className="space-y-6">
            <DefaultsSettings />
            {!isVSCode && (
                <div className="border-t border-border/40 pt-6">
                    <OpenCodeCliSettings />
                </div>
            )}
            {showDesktopNetworkSettings && (
                <div className="border-t border-border/40 pt-6">
                    <DesktopNetworkSettings />
                </div>
            )}
            <div className="border-t border-border/40 pt-6">
                <SessionRetentionSettings />
            </div>
            <div className="border-t border-border/40 pt-6">
                <PasskeySettings />
            </div>
        </div>
    );
};

// Git section: Commit message model, Worktree settings
const GitSectionContent: React.FC = () => {
    return (
        <div className="space-y-6">
            <GitSettings />
        </div>
    );
};

// GitHub section: Connect account for PR/issue workflows
const GitHubSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <GitHubSettings />;
};

// Notifications section: Native browser notifications
const NotificationSectionContent: React.FC = () => {
    return <NotificationSettings />;
};

// Voice section: Language selection and continuous mode
const VoiceSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <VoiceSettings />;
};

const TunnelSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <TunnelSettings />;
};
