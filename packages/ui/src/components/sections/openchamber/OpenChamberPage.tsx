import React from 'react';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';
import { AboutSettings } from './AboutSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { MergedWorktreeCleanupSettings } from './MergedWorktreeCleanupSettings';
import { SessionWorkSettings } from './SessionWorkSettings';
import { PasskeySettings } from './PasskeySettings';
import { AppLinkSecuritySettings } from './AppLinkSecuritySettings';
import { DefaultsSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { VoiceSettings } from './VoiceSettings';
import { TunnelSettings } from './TunnelSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { IsolatedSpacesSettings } from './IsolatedSpacesSettings';
import { ISOLATED_SPACES_RELEASED } from '@/lib/spaces/release';
import { OpenChamberToolsSettings } from './OpenChamberToolsSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { OpenChamberSection } from './types';

const useRuntimeEndpointEpoch = (): number => {
    const [epoch, setEpoch] = React.useState(0);

    React.useEffect(() => {
        return subscribeRuntimeEndpointChanged(() => setEpoch((current) => current + 1));
    }, []);

    return epoch;
};

interface OpenChamberPageProps {
    /** Which section to display. If undefined, shows all sections (mobile/legacy behavior) */
    section?: OpenChamberSection;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({ section }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    const showAbout = isMobile && isWebRuntime();
    const isVSCode = isVSCodeRuntime();
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();

    // If no section specified, show all (mobile/legacy behavior)
    if (!section) {
        return (
            <SettingsPageLayout showSaveStatus className="openchamber-page-body space-y-3 sm:space-y-6">
                <OpenChamberVisualSettings />
                <DefaultsSettings key={runtimeEndpointEpoch} />
                <SessionWorkSettings />
                {showDesktopNetworkSettings && <DesktopNetworkSettings />}
                {!isVSCode && <OpenCodeCliSettings />}
                {!isVSCode && <OpenChamberToolsSettings />}
                <SessionRetentionSettings />
                {!isVSCode && <MergedWorktreeCleanupSettings />}
                <AppLinkSecuritySettings />
                {isWebRuntime() && !isDesktopShell() && !isVSCode && !isCapacitorApp() && <PasskeySettings />}
                {showAbout && <AboutSettings />}
            </SettingsPageLayout>
        );
    }

    // Show specific section content
    const renderSectionContent = () => {
        switch (section) {
            case 'general':
                return <GeneralSectionContent />;
            case 'visual':
                return <VisualSectionContent />;
            case 'chat':
                return <ChatSectionContent />;
            case 'sessions':
                return <SessionsSectionContent runtimeEndpointEpoch={runtimeEndpointEpoch} />;
            case 'shortcuts':
                return <ShortcutsSectionContent />;
            case 'git':
                return <GitSectionContent />;
            case 'notifications':
                return <NotificationSectionContent />;
            case 'voice':
                return <VoiceSectionContent />;
            case 'tunnel':
                return <TunnelSectionContent />;
            case 'spaces':
                return <SpacesSectionContent />;
            default:
                return null;
        }
    };

    const pageTitle = {
        general: t('settings.page.general.title'),
        visual: t('settings.page.appearance.title'),
        chat: t('settings.page.chat.title'),
        sessions: t('settings.page.sessions.title'),
        shortcuts: t('settings.page.shortcuts.title'),
        git: t('settings.page.git.title'),
        github: t('settings.page.git.title'),
        notifications: t('settings.page.notifications.title'),
        voice: t('settings.page.voice.title'),
        tunnel: t('settings.page.tunnel.title'),
        spaces: t('settings.openchamber.spaces.title'),
    }[section];

    const pageDescription = {
        general: t('settings.page.general.description'),
        visual: t('settings.page.appearance.description'),
        chat: t('settings.page.chat.description'),
        sessions: t('settings.page.sessions.description'),
        shortcuts: t('settings.page.shortcuts.description'),
        git: undefined,
        github: undefined,
        notifications: t('settings.page.notifications.description'),
        voice: t('settings.page.voice.description'),
        tunnel: t('settings.page.tunnel.description'),
        spaces: undefined,
    }[section];

    return (
        <SettingsPageLayout
            title={pageTitle}
            description={pageDescription}
            showSaveStatus
            className="openchamber-page-body"
        >
            {renderSectionContent()}
        </SettingsPageLayout>
    );
};

const ShortcutsSectionContent: React.FC = () => {
    return <KeyboardShortcutsSettings />;
};

// General section: app-level settings — startup/tray/network, access password,
// passkeys, OpenCode CLI binary, message stream transport, privacy.
const GeneralSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    void runtimeEndpointEpoch;
    const showDesktopNetworkSettings = isDesktopShell() && isDesktopLocalOriginActive();
    // Passkeys only work against the browser's WebAuthn UI on the web surface —
    // desktop shell, VS Code, and the Capacitor app never show the login screen.
    const showPasskeySettings = isWebRuntime() && !isDesktopShell() && !isVSCode && !isCapacitorApp();
    return (
        <>
            {showDesktopNetworkSettings && <DesktopNetworkSettings />}
            {showPasskeySettings && <PasskeySettings />}
            <AppLinkSecuritySettings />
            {!isVSCode && <OpenCodeCliSettings />}
            {!isVSCode && <OpenChamberToolsSettings />}
            <OpenChamberVisualSettings visibleSettings={[
                'fileEditorKeymap',
                ...(!isVSCode ? ['sessionTabs' as const] : []),
                'autoSaveEnabled',
                ...(!isVSCode ? ['terminalQuickKeys' as const] : []),
                ...(!isVSCode ? ['terminalShell' as const] : []),
                ...(!isVSCode ? ['terminalLoginShell' as const] : []),
                'messageTransport',
                'reportUsage',
            ]} />
        </>
    );
};

// Visual section: Theme Mode, Font Size, Spacing, Input Bar Offset (mobile), Nav Rail
const VisualSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    return <OpenChamberVisualSettings visibleSettings={[
        'theme',
        'windowControlsPosition',
        'pwaInstallName',
        'pwaOrientation',
        'mobileKeyboardMode',
        'timeFormat',
        ...(!isVSCode ? ['weekStart' as const] : []),
        'fontSize',
        'terminalFontSize',
        'editorFontSize',
        'spacing',
        'scrollbars',
        'inputBarOffset',
        'animatedActivityIndicators',
    ]} />;
};

// Chat section: User message rendering, Diff layout, Mobile status bar, Show reasoning traces, Follow-up behavior, Persist draft
const ChatSectionContent: React.FC = () => {
    return (
        <OpenChamberVisualSettings
            visibleSettings={[
                'sessionGoal',
                'sessionAssist',
                'chatRenderMode',
                'activityRenderMode',
                'userMessageRendering',
                'mermaidRendering',
                'reasoning',
                'showToolFileIcons',
                'showTurnChangedFiles',
                'expandedTools',
                'collapsibleUserMessages',
                'stickyUserHeader',
                'promptNavigatorEnabled',
                'wideChatLayout',
                'codeBlockLineWrap',
                'copyMessagesAsPlainText',
                'splitAssistantMessageActions',
                'subagentReadOnlyBanner',
                'diffLayout',
                'inputHistoryScope',
                'inputHistoryLimit',
                'messageSearch',
                'dotfiles',
                'fileViewerPreview',
                'followUpBehavior',
                'persistDraft',
                'inputSpellcheck',
                'largeTextPaste',
                'enterToSend',
            ]}
        />
    );
};

// Sessions section: Default model & agent, Session retention
const SessionsSectionContent: React.FC<{ runtimeEndpointEpoch: number }> = ({ runtimeEndpointEpoch }) => {
    return (
        <>
            <DefaultsSettings key={runtimeEndpointEpoch} />
            <SessionWorkSettings />
            <SessionRetentionSettings />
            {!isVSCodeRuntime() && <MergedWorktreeCleanupSettings />}
        </>
    );
};

// Git section: Commit message model, Worktree settings
const GitSectionContent: React.FC = () => {
    return <GitSettings />;
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

// Isolated spaces: the switch, the idle stop, the places with their disk, and the spaces without a
// project. Never in VS Code (decision 16), and nowhere until the feature is released.
const SpacesSectionContent: React.FC = () => {
    if (isVSCodeRuntime() || !ISOLATED_SPACES_RELEASED) {
        return null;
    }
    return <IsolatedSpacesSettings />;
};

const TunnelSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
        return null;
    }
    return <TunnelSettings />;
};
