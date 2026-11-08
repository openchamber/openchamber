import React from 'react';

import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsStackedField,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SettingsBadge,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { LIVE_BROWSER_TABS_MAX, LIVE_BROWSER_TABS_MIN } from '@/lib/browser/liveTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TerminalShellOption } from '@/lib/api/types';
import { parseVimMappings } from '@/lib/codemirror/vimMappings';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { setDirectoryShowHidden, useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { isTerminalShell } from '@/lib/terminalShell';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { MobileWorkspaceTabsSettings } from './MobileWorkspaceTabsSettings';
import { isNewSetting } from '@/lib/settings/newSettings';

const MESSAGE_STREAM_TRANSPORT_OPTIONS: Array<{ id: 'auto' | 'ws' | 'sse'; labelKey: I18nKey; descriptionKey: I18nKey }> = [
  {
    id: 'auto',
    labelKey: 'settings.openchamber.visual.option.messageTransport.auto.label',
    descriptionKey: 'settings.openchamber.visual.option.messageTransport.auto.description',
  },
  {
    id: 'ws',
    labelKey: 'settings.openchamber.visual.option.messageTransport.ws.label',
    descriptionKey: 'settings.openchamber.visual.option.messageTransport.ws.description',
  },
  {
    id: 'sse',
    labelKey: 'settings.openchamber.visual.option.messageTransport.sse.label',
    descriptionKey: 'settings.openchamber.visual.option.messageTransport.sse.description',
  },
];

/** Files and the editor: keymap, tree side, saving, hidden files, preview. */
const FilesAndEditorSection: React.FC<{ divider: boolean }> = ({ divider }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const isVSCode = isVSCodeRuntime();
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const setFileEditorKeymap = useUIStore((state) => state.setFileEditorKeymap);
  const fileEditorVimMappings = useUIStore((state) => state.fileEditorVimMappings);
  const setFileEditorVimMappings = useUIStore((state) => state.setFileEditorVimMappings);
  const fileTreeSide = useUIStore((state) => state.fileTreeSide);
  const setFileTreeSide = useUIStore((state) => state.setFileTreeSide);
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);
  const confirmFileTreeMove = useUIStore((state) => state.confirmFileTreeMove);
  const setConfirmFileTreeMove = useUIStore((state) => state.setConfirmFileTreeMove);
  const directoryShowHidden = useDirectoryShowHidden();
  const fileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
  const setFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
  const invalidVimMappingLines = React.useMemo(
    () => parseVimMappings(fileEditorVimMappings).invalidLines,
    [fileEditorVimMappings],
  );

  const handleFileViewerPreviewChange = React.useCallback((enabled: boolean) => {
    setFileViewerPreview(enabled);
    void updateDesktopSettings({ defaultFileViewerPreview: enabled });
    window.dispatchEvent(new CustomEvent('openchamber:file-viewer-preview-mode-changed', { detail: { enabled } }));
  }, [setFileViewerPreview]);

  const showTreeControls = !isVSCode && !isMobile;

  return (
    <SettingsSection title={t('settings.layout.general.files.title')} divider={divider} contentClassName="space-y-4">
      <div>
        <SettingsFieldRow
          label={t('settings.openchamber.visual.field.fileEditorKeymap')}
          settingsItem="appearance.file-editor-keymap"
          labelAccessory={isNewSetting('appearance.file-editor-keymap') ? (
            <SettingsBadge>{t('settings.view.badge.new')}</SettingsBadge>
          ) : undefined}
        >
          <SettingsChipGroup
            value={fileEditorKeymap}
            onChange={setFileEditorKeymap}
            aria-label={t('settings.openchamber.visual.field.fileEditorKeymap')}
            options={[
              { value: 'default', label: t('settings.openchamber.visual.option.fileEditorKeymap.default') },
              { value: 'vim', label: t('settings.openchamber.visual.option.fileEditorKeymap.vim') },
            ]}
          />
        </SettingsFieldRow>
        {fileEditorKeymap === 'vim' ? (
          <SettingsStackedField
            label={t('settings.openchamber.visual.field.fileEditorVimMappings')}
            info={t('settings.openchamber.visual.field.fileEditorVimMappingsInfo')}
            description={invalidVimMappingLines.length > 0
              ? t('settings.openchamber.visual.field.fileEditorVimMappingsInvalid', { lines: invalidVimMappingLines.join(', ') })
              : undefined}
            descriptionPlacement="after"
            settingsItem="appearance.file-editor-vim-mappings"
            className="pt-1 pb-2"
          >
            <Textarea
              value={fileEditorVimMappings}
              onChange={(event) => setFileEditorVimMappings(event.target.value)}
              placeholder="inoremap jk <Esc>"
              aria-label={t('settings.openchamber.visual.field.fileEditorVimMappings')}
              rows={4}
              spellCheck={false}
              className="w-full font-mono typography-meta"
            />
          </SettingsStackedField>
        ) : null}
        {showTreeControls ? (
          <SettingsFieldRow
            label={t('settings.openchamber.visual.field.fileTreeSide')}
            settingsItem="appearance.file-tree-side"
          >
            <SettingsChipGroup
              value={fileTreeSide}
              onChange={setFileTreeSide}
              aria-label={t('settings.openchamber.visual.field.fileTreeSide')}
              options={[
                { value: 'left', label: t('settings.openchamber.visual.option.fileTreeSide.left') },
                { value: 'right', label: t('settings.openchamber.visual.option.fileTreeSide.right') },
              ]}
            />
          </SettingsFieldRow>
        ) : null}
      </div>

      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          checked={autoSaveEnabled}
          onChange={setAutoSaveEnabled}
          label={t('settings.openchamber.visual.field.autoSaveEnabled')}
          ariaLabel={t('settings.openchamber.visual.field.autoSaveEnabledAria')}
          info={t('settings.openchamber.visual.field.autoSaveEnabledInfo')}
          settingsItem="appearance.auto-save-enabled"
          labelAccessory={isNewSetting('appearance.auto-save-enabled') ? (
            <SettingsBadge>{t('settings.view.badge.new')}</SettingsBadge>
          ) : undefined}
        />
        {showTreeControls ? (
          <SettingsCheckboxRow
            checked={confirmFileTreeMove}
            onChange={setConfirmFileTreeMove}
            label={t('settings.openchamber.visual.field.confirmFileTreeMove')}
            ariaLabel={t('settings.openchamber.visual.field.confirmFileTreeMove')}
            settingsItem="appearance.confirm-file-tree-move"
          />
        ) : null}
        {!isVSCode ? (
          <SettingsCheckboxRow
            checked={directoryShowHidden}
            onChange={setDirectoryShowHidden}
            label={t('settings.openchamber.visual.field.showDotfiles')}
            ariaLabel={t('settings.openchamber.visual.field.showDotfilesAria')}
            settingsItem="chat.dotfiles"
          />
        ) : null}
        <SettingsCheckboxRow
          checked={fileViewerPreview}
          onChange={handleFileViewerPreviewChange}
          label={t('settings.openchamber.defaults.field.openFilesPreview')}
          ariaLabel={t('settings.openchamber.defaults.field.openFilesPreviewAria')}
          settingsItem="general.file-viewer-preview"
        />
      </div>
    </SettingsSection>
  );
};

/** The built-in terminal: which shell, login mode, quick keys. Not in VS Code. */
const TerminalSection: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const { terminal } = useRuntimeAPIs();
  const terminalShell = useUIStore((state) => state.terminalShell);
  const setTerminalShell = useUIStore((state) => state.setTerminalShell);
  const terminalLoginShells = useUIStore((state) => state.terminalLoginShells);
  const setTerminalLoginShells = useUIStore((state) => state.setTerminalLoginShells);
  const showTerminalQuickKeysOnDesktop = useUIStore((state) => state.showTerminalQuickKeysOnDesktop);
  const setShowTerminalQuickKeysOnDesktop = useUIStore((state) => state.setShowTerminalQuickKeysOnDesktop);
  const terminalCloseOnExit = useUIStore((state) => state.terminalCloseOnExit);
  const setTerminalCloseOnExit = useUIStore((state) => state.setTerminalCloseOnExit);
  const [availableTerminalShells, setAvailableTerminalShells] = React.useState<TerminalShellOption[]>([]);
  const [terminalShellRuntimeEpoch, setTerminalShellRuntimeEpoch] = React.useState(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setAvailableTerminalShells([]);
    setTerminalShellRuntimeEpoch((epoch) => epoch + 1);
  }), []);

  React.useEffect(() => {
    let cancelled = false;
    if (!terminal.listShells) return;
    void terminal.listShells()
      .then((shells) => {
        if (!cancelled) setAvailableTerminalShells(shells);
      })
      .catch(() => {
        if (!cancelled) setAvailableTerminalShells([]);
      });
    return () => {
      cancelled = true;
    };
  }, [terminal, terminalShellRuntimeEpoch]);

  const terminalShellOptions = React.useMemo(() => {
    const explicitShells = availableTerminalShells.filter((shell) => shell.id !== 'auto');
    if (terminalShell === 'auto' || explicitShells.some((shell) => shell.id === terminalShell)) {
      return explicitShells;
    }
    return [{ id: terminalShell, name: terminalShell, supportsLogin: false }, ...explicitShells];
  }, [availableTerminalShells, terminalShell]);
  const terminalShellSupportsLogin = availableTerminalShells.find((shell) => shell.id === terminalShell)?.supportsLogin === true;
  const terminalLoginShellEnabled = terminalLoginShells.includes(terminalShell);
  const setTerminalLoginShellEnabled = (enabled: boolean) => {
    setTerminalLoginShells(enabled
      ? [...terminalLoginShells.filter((shell) => shell !== terminalShell), terminalShell]
      : terminalLoginShells.filter((shell) => shell !== terminalShell));
  };

  return (
    <SettingsSection title={t('settings.layout.general.terminal.title')} contentClassName="space-y-3">
      <SettingsFieldRow
        label={t('settings.openchamber.visual.field.terminalShell')}
        info={t('settings.openchamber.visual.field.terminalShellHint')}
        settingsItem="appearance.terminal-shell"
      >
        <Select value={terminalShell} onValueChange={(value) => { if (isTerminalShell(value)) setTerminalShell(value); }}>
          <SelectTrigger aria-label={t('settings.openchamber.visual.field.terminalShellAria')} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
            <SelectValue>
              {terminalShell === 'auto'
                ? t('settings.openchamber.visual.option.terminalShell.auto')
                : terminalShellOptions.find((shell) => shell.id === terminalShell)?.name ?? terminalShell}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('settings.openchamber.visual.option.terminalShell.auto')}</SelectItem>
            {terminalShellOptions.map((shell) => (
              <SelectItem key={shell.id} value={shell.id}>{shell.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        {terminalShellSupportsLogin ? (
          <SettingsCheckboxRow
            checked={terminalLoginShellEnabled}
            onChange={setTerminalLoginShellEnabled}
            label={t('settings.openchamber.visual.field.terminalLoginShell')}
            ariaLabel={t('settings.openchamber.visual.field.terminalLoginShell')}
            settingsItem="appearance.terminal-login-shell"
          />
        ) : null}
        <SettingsCheckboxRow
          checked={terminalCloseOnExit}
          onChange={setTerminalCloseOnExit}
          label={t('settings.openchamber.visual.field.terminalCloseOnExit')}
          ariaLabel={t('settings.openchamber.visual.field.terminalCloseOnExit')}
          info={t('settings.openchamber.visual.field.terminalCloseOnExitInfo')}
          settingsItem="appearance.terminal-close-on-exit"
        />
        {!isMobile ? (
          <SettingsCheckboxRow
            checked={showTerminalQuickKeysOnDesktop}
            onChange={setShowTerminalQuickKeysOnDesktop}
            label={t('settings.openchamber.visual.field.terminalQuickKeys')}
            ariaLabel={t('settings.openchamber.visual.field.terminalQuickKeysAria')}
            settingsItem="appearance.terminal-quick-keys"
            info={t('settings.openchamber.visual.field.terminalQuickKeysTooltip', {
              control: formatShortcutForDisplay('ctrl'),
              alt: formatShortcutForDisplay('alt'),
            })}
          />
        ) : null}
      </div>
    </SettingsSection>
  );
};

/** How the window behaves: header tabs, panel motion, where links open. */
const PanelsAndLinksSection: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const sessionTabsEnabled = useUIStore((state) => state.sessionTabsEnabled);
  const setSessionTabsEnabled = useUIStore((state) => state.setSessionTabsEnabled);
  const sessionTabsPerWorkspace = useUIStore((state) => state.sessionTabsPerWorkspace);
  const setSessionTabsPerWorkspace = useUIStore((state) => state.setSessionTabsPerWorkspace);
  const layoutAnimations = useUIStore((state) => state.layoutAnimations);
  const setLayoutAnimations = useUIStore((state) => state.setLayoutAnimations);
  const openLinksInBrowserPanel = useUIStore((state) => state.openLinksInBrowserPanel);
  const setOpenLinksInBrowserPanel = useUIStore((state) => state.setOpenLinksInBrowserPanel);
  const liveBrowserTabLimit = useUIStore((state) => state.liveBrowserTabLimit);
  const setLiveBrowserTabLimit = useUIStore((state) => state.setLiveBrowserTabLimit);
  const openTrackerLinksOnBoard = useUIStore((state) => state.openTrackerLinksOnBoard);
  const setOpenTrackerLinksOnBoard = useUIStore((state) => state.setOpenTrackerLinksOnBoard);

  return (
    <SettingsSection title={t('settings.layout.general.panels.title')} contentClassName={SETTINGS_OPTION_STACK_CLASS}>
      {!isMobile ? (
        <SettingsCheckboxRow
          checked={sessionTabsEnabled}
          onChange={setSessionTabsEnabled}
          label={t('settings.openchamber.visual.field.sessionTabs')}
          ariaLabel={t('settings.openchamber.visual.field.sessionTabsAria')}
          info={t('settings.openchamber.visual.field.sessionTabsInfo')}
          settingsItem="appearance.session-tabs"
        />
      ) : null}
      {!isMobile && sessionTabsEnabled ? (
        <SettingsCheckboxRow
          checked={sessionTabsPerWorkspace}
          onChange={setSessionTabsPerWorkspace}
          label={t('settings.openchamber.visual.field.sessionTabsPerWorkspace')}
          ariaLabel={t('settings.openchamber.visual.field.sessionTabsPerWorkspaceAria')}
          info={t('settings.openchamber.visual.field.sessionTabsPerWorkspaceInfo')}
          className="ps-6"
        />
      ) : null}
      {!isMobile ? (
        <SettingsCheckboxRow
          checked={layoutAnimations}
          onChange={setLayoutAnimations}
          label={t('settings.openchamber.visual.field.layoutAnimations')}
          ariaLabel={t('settings.openchamber.visual.field.layoutAnimationsAria')}
          info={t('settings.openchamber.visual.field.layoutAnimationsInfo')}
          settingsItem="appearance.layout-animations"
        />
      ) : null}
      {isDesktopShell() && !isMobile ? (
        <SettingsCheckboxRow
          checked={openLinksInBrowserPanel}
          onChange={setOpenLinksInBrowserPanel}
          label={t('settings.openchamber.visual.field.openLinksInBrowserPanel')}
          ariaLabel={t('settings.openchamber.visual.field.openLinksInBrowserPanel')}
          info={t('settings.openchamber.visual.field.openLinksInBrowserPanelInfo')}
          settingsItem="appearance.open-links-in-browser-panel"
        />
      ) : null}
      <SettingsCheckboxRow
        checked={openTrackerLinksOnBoard}
        onChange={setOpenTrackerLinksOnBoard}
        label={t('settings.openchamber.visual.field.openTrackerLinksOnBoard')}
        ariaLabel={t('settings.openchamber.visual.field.openTrackerLinksOnBoard')}
        info={t('settings.openchamber.visual.field.openTrackerLinksOnBoardInfo')}
        settingsItem="appearance.open-tracker-links-on-board"
      />
      {isDesktopShell() && !isMobile ? (
        <SettingsFieldRow
          label={t('settings.openchamber.visual.field.liveBrowserTabs')}
          info={t('settings.openchamber.visual.field.liveBrowserTabsInfo')}
          settingsItem="appearance.live-browser-tabs"
        >
          <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
            <NumberInput
              value={liveBrowserTabLimit}
              onValueChange={setLiveBrowserTabLimit}
              min={LIVE_BROWSER_TABS_MIN}
              max={LIVE_BROWSER_TABS_MAX}
              step={1}
              className={SETTINGS_NUMBER_INPUT_CLASS}
              deferExternalValueWhileFocused
              aria-label={t('settings.openchamber.visual.field.liveBrowserTabs')}
            />
            <span className={SETTINGS_NUMBER_UNIT_CLASS}>
              {t('settings.openchamber.visual.field.liveBrowserTabsUnit')}
            </span>
          </div>
        </SettingsFieldRow>
      ) : null}
    </SettingsSection>
  );
};

/**
 * The workspace part of General: files and the editor, the terminal, and how
 * panels and links behave. VS Code keeps only the editor settings it applies.
 */
export const GeneralWorkspaceSettings: React.FC<{
  /** The page opens on these sections (no desktop app section above them). */
  firstSection: boolean;
}> = ({ firstSection }) => {
  const isVSCode = isVSCodeRuntime();
  const { isMobile } = useDeviceInfo();
  return (
    <>
      <FilesAndEditorSection divider={!firstSection} />
      {isVSCode ? null : <TerminalSection />}
      {isVSCode ? null : <PanelsAndLinksSection />}
      {isMobile ? <MobileWorkspaceTabsSettings /> : null}
    </>
  );
};

/** The last sections of General: how messages stream in, and usage reports. */
export const GeneralConnectionAndPrivacySettings: React.FC = () => {
  const { t } = useI18n();
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport);
  const setMessageStreamTransport = useConfigStore((state) => state.setSettingsMessageStreamTransport);
  const reportUsage = useUIStore((state) => state.reportUsage);
  const setReportUsage = useUIStore((state) => state.setReportUsage);
  const selectedTransport = MESSAGE_STREAM_TRANSPORT_OPTIONS.find((option) => option.id === messageStreamTransport);

  const handleMessageStreamTransportChange = React.useCallback((mode: 'auto' | 'ws' | 'sse') => {
    setMessageStreamTransport(mode);
    void updateDesktopSettings({ messageStreamTransport: mode });
  }, [setMessageStreamTransport]);

  // Sync reportUsage changes to server settings
  const handleReportUsageChange = React.useCallback((enabled: boolean) => {
    setReportUsage(enabled);
    void updateDesktopSettings({ reportUsage: enabled });
  }, [setReportUsage]);

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.visual.section.messageStreamTransport')}
        settingsItem="chat.message-transport"
        contentClassName="space-y-2"
      >
        <SettingsChipGroup
          value={messageStreamTransport}
          options={MESSAGE_STREAM_TRANSPORT_OPTIONS.map((option) => ({
            value: option.id,
            label: t(option.labelKey),
          }))}
          onChange={handleMessageStreamTransportChange}
          aria-label={t('settings.openchamber.visual.section.messageStreamTransport')}
        />
        {selectedTransport ? (
          <p className="typography-meta text-muted-foreground">{t(selectedTransport.descriptionKey)}</p>
        ) : null}
      </SettingsSection>
      <SettingsSection title={t('settings.openchamber.visual.section.privacy')}>
        <SettingsCheckboxRow
          checked={reportUsage}
          onChange={handleReportUsageChange}
          label={t('settings.openchamber.visual.field.sendAnonymousUsageReports')}
          info={t('settings.openchamber.visual.field.sendAnonymousUsageReportsHint')}
          ariaLabel={t('settings.openchamber.visual.field.sendAnonymousUsageReportsAria')}
          settingsItem="appearance.usage-reports"
        />
      </SettingsSection>
    </>
  );
};
