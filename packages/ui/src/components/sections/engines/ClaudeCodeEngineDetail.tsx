import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsChipGroup,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  setCachedWarnOnOpenCodeHandoff,
  setCachedClaudeAgentsMode,
  withEnginesSettingsDefaults,
  type ClaudeAgentsMode,
} from '@/lib/harness/settings';
import { openExternalUrl } from '@/lib/url';
import { useHarnessStore } from '@/stores/useHarnessStore';
import { useUIStore } from '@/stores/useUIStore';
import type { CapabilityLevel, HarnessCapability, HarnessRuntimeStatus } from '@/types/harness';
import { HARNESS_CAPABILITIES } from '@/types/harness';
import { useShallow } from 'zustand/react/shallow';

const STATUS_LABEL_KEYS: Record<
  HarnessRuntimeStatus,
  | 'settings.engines.sidebar.status.ready'
  | 'settings.engines.sidebar.status.needsLogin'
  | 'settings.engines.sidebar.status.missingCli'
  | 'settings.engines.sidebar.status.unsupportedHost'
  | 'settings.engines.sidebar.status.error'
> = {
  ready: 'settings.engines.sidebar.status.ready',
  'needs-login': 'settings.engines.sidebar.status.needsLogin',
  'missing-cli': 'settings.engines.sidebar.status.missingCli',
  'unsupported-host': 'settings.engines.sidebar.status.unsupportedHost',
  error: 'settings.engines.sidebar.status.error',
};

const CAPABILITY_LABEL_KEYS: Record<HarnessCapability, `settings.engines.capability.${HarnessCapability}`> = {
  prompt: 'settings.engines.capability.prompt',
  abort: 'settings.engines.capability.abort',
  resume: 'settings.engines.capability.resume',
  'streaming-text': 'settings.engines.capability.streaming-text',
  'streaming-tools': 'settings.engines.capability.streaming-tools',
  permissions: 'settings.engines.capability.permissions',
  images: 'settings.engines.capability.images',
  'file-attachments': 'settings.engines.capability.file-attachments',
  shell: 'settings.engines.capability.shell',
  'slash-commands': 'settings.engines.capability.slash-commands',
  mcp: 'settings.engines.capability.mcp',
  subagents: 'settings.engines.capability.subagents',
  multirun: 'settings.engines.capability.multirun',
  goal: 'settings.engines.capability.goal',
  'openchamber-tool': 'settings.engines.capability.openchamber-tool',
};

const LEVEL_LABEL_KEYS: Record<
  CapabilityLevel,
  | 'settings.engines.claudeCode.capability.full'
  | 'settings.engines.claudeCode.capability.partial'
  | 'settings.engines.claudeCode.capability.none'
> = {
  full: 'settings.engines.claudeCode.capability.full',
  partial: 'settings.engines.claudeCode.capability.partial',
  none: 'settings.engines.claudeCode.capability.none',
};

const CLAUDE_DOCS_FALLBACK = 'https://docs.anthropic.com/en/docs/claude-code';

export const ClaudeCodeEngineDetail: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const { catalog, isDetecting, detect, error, loadState } = useHarnessStore(useShallow((s) => ({
    catalog: s.catalogsById['claude-code'],
    isDetecting: Boolean(s.isDetecting['claude-code']),
    detect: s.detect,
    error: s.error,
    loadState: s.loadState,
  })));

  const [warnOnHandoff, setWarnOnHandoff] = React.useState(true);
  const [agentsMode, setAgentsMode] = React.useState<ClaudeAgentsMode>('opencode');
  const [settingsLoaded, setSettingsLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return;
        }
        const data = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (cancelled || !data) {
          return;
        }
        const resolved = withEnginesSettingsDefaults({
          enginesClaudeCodeWarnOnOpenCodeHandoff:
            typeof data.enginesClaudeCodeWarnOnOpenCodeHandoff === 'boolean'
              ? data.enginesClaudeCodeWarnOnOpenCodeHandoff
              : undefined,
          enginesClaudeCodeAgentsMode:
            data.enginesClaudeCodeAgentsMode === 'claude' || data.enginesClaudeCodeAgentsMode === 'opencode'
              ? data.enginesClaudeCodeAgentsMode
              : undefined,
        });
        setWarnOnHandoff(resolved.enginesClaudeCodeWarnOnOpenCodeHandoff);
        setCachedWarnOnOpenCodeHandoff(resolved.enginesClaudeCodeWarnOnOpenCodeHandoff);
        setAgentsMode(resolved.enginesClaudeCodeAgentsMode);
        setCachedClaudeAgentsMode(resolved.enginesClaudeCodeAgentsMode);
      } catch {
        // keep default
      } finally {
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleWarnChange = React.useCallback((enabled: boolean) => {
    setWarnOnHandoff(enabled);
    setCachedWarnOnOpenCodeHandoff(enabled);
    void updateDesktopSettings({ enginesClaudeCodeWarnOnOpenCodeHandoff: enabled });
  }, []);

  const handleAgentsModeChange = React.useCallback((mode: ClaudeAgentsMode) => {
    setAgentsMode(mode);
    setCachedClaudeAgentsMode(mode);
    void updateDesktopSettings({ enginesClaudeCodeAgentsMode: mode });
  }, []);

  const handleRedetect = React.useCallback(() => {
    void detect('claude-code');
  }, [detect]);

  const docsUrl = catalog?.engine.install.docsUrl || CLAUDE_DOCS_FALLBACK;
  const status = catalog?.status;
  const capabilities = catalog?.engine.capabilities;

  return (
    <SettingsPageLayout
      title={t('settings.engines.claudeCode.title')}
      description={t('settings.engines.claudeCode.description')}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.engines.claudeCode.section.status')}
        divider={false}
        settingsItem="engines.claude-code"
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsFieldRow label={t('settings.engines.claudeCode.field.status')}>
          <span className="typography-ui text-foreground">
            {status
              ? t(STATUS_LABEL_KEYS[status])
              : loadState === 'loading'
                ? t('settings.engines.sidebar.status.loading')
                : t('settings.engines.sidebar.status.unknown')}
          </span>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.engines.claudeCode.field.version')}>
          <span className="typography-ui text-foreground">
            {catalog?.version
              ? t('settings.engines.claudeCode.status.version', { version: catalog.version })
              : t('settings.engines.claudeCode.status.versionUnknown')}
          </span>
        </SettingsFieldRow>
        {catalog?.statusDetail || error ? (
          <p className={SETTINGS_HELPER_CLASS}>{catalog?.statusDetail || error}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isDetecting}
            onClick={handleRedetect}
            aria-label={t('settings.engines.claudeCode.actions.redetectAria')}
          >
            {isDetecting
              ? t('settings.engines.sidebar.status.loading')
              : t('settings.engines.claudeCode.actions.redetect')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void openExternalUrl(docsUrl)}
            aria-label={t('settings.engines.claudeCode.actions.openDocsAria')}
          >
            {t('settings.engines.claudeCode.actions.openDocs')}
          </Button>
        </div>
        {status === 'needs-login' || status === 'missing-cli' ? (
          <div className="space-y-1">
            <p className="typography-ui-label text-foreground">{t('settings.engines.claudeCode.login.title')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.claudeCode.login.body')}</p>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t('settings.engines.claudeCode.section.capabilities')}
        settingsItem="engines.claude-code.capabilities"
        contentClassName="space-y-2"
      >
        {capabilities ? (
          <ul className="space-y-1.5">
            {HARNESS_CAPABILITIES.map((capability) => {
              const level = capabilities[capability];
              return (
                <li key={capability} className="flex items-baseline justify-between gap-3">
                  <span className="typography-ui text-foreground">{t(CAPABILITY_LABEL_KEYS[capability])}</span>
                  <span className="typography-meta text-muted-foreground shrink-0">{t(LEVEL_LABEL_KEYS[level])}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.claudeCode.capabilities.empty')}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.engines.claudeCode.section.agents')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsFieldRow
          label={t('settings.engines.claudeCode.agentsMode.label')}
          info={t('settings.engines.claudeCode.agentsMode.info')}
          settingsItem="engines.claude-code.agents-mode"
        >
          <SettingsChipGroup
            aria-label={t('settings.engines.claudeCode.agentsMode.aria')}
            value={agentsMode}
            onChange={handleAgentsModeChange}
            options={[
              {
                value: 'claude',
                label: t('settings.engines.claudeCode.agentsMode.claude'),
                disabled: !settingsLoaded,
              },
              {
                value: 'opencode',
                label: t('settings.engines.claudeCode.agentsMode.opencode'),
                disabled: !settingsLoaded,
              },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t('settings.engines.claudeCode.section.warnings')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={warnOnHandoff}
          onChange={handleWarnChange}
          disabled={!settingsLoaded}
          label={t('settings.engines.claudeCode.warnHandoff.label')}
          ariaLabel={t('settings.engines.claudeCode.warnHandoff.aria')}
          info={t('settings.engines.claudeCode.warnHandoff.info')}
          settingsItem="engines.claude-code.warn-handoff"
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.engines.claudeCode.section.apiKeys')}
        settingsItem="engines.claude-code.api-keys"
        contentClassName="space-y-3"
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.claudeCode.apiKeys.note')}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setSettingsPage('providers')}
        >
          {t('settings.engines.opencode.link.providers')}
        </Button>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
