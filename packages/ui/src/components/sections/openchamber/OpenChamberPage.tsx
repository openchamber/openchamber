import React from 'react';
import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';
import { SessionRetentionSettings } from './SessionRetentionSettings';
import { FinishedWorktreesSettings } from './FinishedWorktreesSettings';
import { SessionWorkSettings } from './SessionWorkSettings';
import { PasskeySettings } from './PasskeySettings';
import { AppLinkSecuritySettings } from './AppLinkSecuritySettings';
import { DefaultsSettings, SessionContextSettings } from './DefaultsSettings';
import { GitSettings } from './GitSettings';
import { NotificationSettings } from './NotificationSettings';
import { VoiceSettings } from './VoiceSettings';
import { TunnelSettings } from './TunnelSettings';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';
import { EnvironmentVariablesSettings } from './EnvironmentVariablesSettings';
import { IsolatedSpacesSettings } from './IsolatedSpacesSettings';
import { OpenChamberToolsSettings } from './OpenChamberToolsSettings';
import { DesktopNetworkSettings } from './DesktopNetworkSettings';
import { DesktopAppSettings, DesktopQuickAccessSettings } from './DesktopAppSettings';
import { ChatSettings } from './ChatSettings';
import { GeneralConnectionAndPrivacySettings, GeneralFilesAndTerminalSettings, GeneralInterfaceSettings } from './GeneralWorkspaceSettings';
import { MobileAppSettings } from './MobileAppSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
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
    /** Which section to display. */
    section: OpenChamberSection;
}

export const OpenChamberPage: React.FC<OpenChamberPageProps> = ({ section }) => {
    const { t } = useI18n();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();

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

    return (
        <SettingsPageLayout
            title={pageTitle}
            namedBySidebar
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

// General, by what people come here for: the desktop or phone app itself, the agent's
// tools, how other devices reach this app, the window, global shortcuts, the
// OpenCode CLI and its environment, files and the terminal, then trusted
// links, message transport and privacy. The layout drops the divider above
// whichever section renders first.
const GeneralSectionContent: React.FC = () => {
    const isVSCode = isVSCodeRuntime();
    const runtimeEndpointEpoch = useRuntimeEndpointEpoch();
    const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
    // Passkeys only work against the browser's WebAuthn UI on the web surface —
    // desktop shell, VS Code, and the Capacitor app never show the login screen.
    const showPasskeySettings = isWebRuntime() && !isDesktopShell() && !isVSCode && !isCapacitorApp();
    return (
        <>
            {/* Remote hosts too: the Dock badge works there. */}
            {isDesktopShell() && <DesktopAppSettings />}
            <MobileAppSettings />
            {!isVSCode && <OpenChamberToolsSettings />}
            {isLocalDesktop && <DesktopNetworkSettings />}
            {showPasskeySettings && <PasskeySettings />}
            <GeneralInterfaceSettings />
            {isLocalDesktop && <DesktopQuickAccessSettings />}
            {!isVSCode && <OpenCodeCliSettings />}
            {/* Remounts on a runtime switch: the names come from that server. */}
            {!isVSCode && <EnvironmentVariablesSettings key={runtimeEndpointEpoch} />}
            <GeneralFilesAndTerminalSettings />
            <AppLinkSecuritySettings />
            <GeneralConnectionAndPrivacySettings />
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

const ChatSectionContent: React.FC = () => <ChatSettings />;

// Sessions: the models sessions run on, then what the sidebar shows and what
// gets cleaned out of it, then the context mechanics (compaction, prompt cache).
const SessionsSectionContent: React.FC<{ runtimeEndpointEpoch: number }> = ({ runtimeEndpointEpoch }) => {
    return (
        <>
            <DefaultsSettings key={`defaults-${runtimeEndpointEpoch}`} />
            <SessionWorkSettings />
            <SessionRetentionSettings />
            {!isVSCodeRuntime() && <FinishedWorktreesSettings />}
            <SessionContextSettings key={`context-${runtimeEndpointEpoch}`} />
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
// project. Never in VS Code (decision 16); whether Settings offers the page at all is the page's
// `isAvailable` in lib/settings/metadata.ts.
const SpacesSectionContent: React.FC = () => {
    if (isVSCodeRuntime()) {
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
