import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Jira brand mark — intentional product color, not a theme token. */
const JIRA_BRAND_CLASS = 'text-[#0052CC]';

type JiraDeployment = 'cloud' | 'server';

interface JiraConnectionSummary {
  deployment: JiraDeployment;
  baseUrl: string;
  email: string | null;
  user: {
    accountId: string | null;
    displayName: string | null;
    emailAddress: string | null;
    avatarUrl: string | null;
  } | null;
}

interface JiraProjectMapping {
  projectKey: string;
  directory: string;
}

interface JiraIntegrationConfig {
  projectMappings: JiraProjectMapping[];
  defaultDirectory: string | null;
  appBaseUrl: string | null;
  updates: {
    started: boolean;
    completed: boolean;
    failed: boolean;
    attention: boolean;
  };
  issueListener: {
    enabled: boolean;
    triggerLabel: string;
    removeTriggerLabel: boolean;
    intervalMs: number;
  };
}

interface JiraStatusPayload {
  connected: boolean;
  connection: JiraConnectionSummary | null;
  config: JiraIntegrationConfig;
}

interface JiraStartResult {
  sessionId: string;
  sessionUrl: string | null;
  promptDispatched: boolean;
  promptError?: string;
  issue: { key: string; summary: string | null; url: string };
  linkage: { recorded: boolean; remoteLinkCreated: boolean; commentPosted: boolean; errors: string[] };
}

async function jiraFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await runtimeFetch(url, init);
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  if (body == null) {
    throw new Error(`Request failed (${response.status})`);
  }
  return body;
}

const postJson = <T,>(url: string, payload: unknown, method = 'POST'): Promise<T> => jiraFetch<T>(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const NO_DIRECTORY_VALUE = '__none__';

interface DirectoryOption {
  path: string;
  label: string;
}

function DirectorySelect({
  value,
  onChange,
  options,
  allowNone,
  noneLabel,
  ariaLabel,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  options: DirectoryOption[];
  allowNone: boolean;
  noneLabel: string;
  ariaLabel: string;
}) {
  return (
    <Select
      value={value ?? (allowNone ? NO_DIRECTORY_VALUE : undefined)}
      onValueChange={(next) => onChange(next === NO_DIRECTORY_VALUE ? null : next)}
    >
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-full">
        <SelectValue placeholder={noneLabel}>
          {(selected) => {
            if (!selected || selected === NO_DIRECTORY_VALUE) return noneLabel;
            return options.find((option) => option.path === selected)?.label ?? selected;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowNone ? <SelectItem value={NO_DIRECTORY_VALUE}>{noneLabel}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.path} value={option.path}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Settings → Integrations → Jira.
 *
 * Connects a Jira Cloud or Server/Data Center account, maps Jira projects to
 * OpenChamber project directories, and configures issue-to-session initiation
 * (trigger label listener) plus lifecycle status updates.
 */
export const JiraSection: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((s) => s.projects);

  const directoryOptions = useMemo<DirectoryOption[]>(
    () => projects
      .filter((project) => typeof project.path === 'string' && project.path)
      .map((project) => ({ path: project.path, label: project.label || project.path })),
    [projects],
  );

  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<JiraConnectionSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Connect form state
  const [deployment, setDeployment] = useState<JiraDeployment>('cloud');
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Config editing state
  const [draft, setDraft] = useState<JiraIntegrationConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Start-from-issue state
  const [issueKey, setIssueKey] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startResult, setStartResult] = useState<JiraStartResult | null>(null);

  const applyStatus = useCallback((status: JiraStatusPayload) => {
    setConnection(status.connected ? status.connection : null);
    setDraft(status.config);
    setDirty(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await jiraFetch<JiraStatusPayload>('/api/jira/status');
      applyStatus(status);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const status = await postJson<JiraStatusPayload>('/api/jira/connect', {
        deployment,
        baseUrl,
        email: deployment === 'cloud' ? email : undefined,
        apiToken,
      });
      applyStatus({ ...status, connected: true });
      setApiToken('');
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await jiraFetch('/api/jira/auth', { method: 'DELETE' });
      setConnection(null);
      setStartResult(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateDraft = (updater: (current: JiraIntegrationConfig) => JiraIntegrationConfig) => {
    setDraft((current) => (current ? updater(current) : current));
    setDirty(true);
    setSaveError(null);
  };

  const saveConfig = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await postJson<{ config: JiraIntegrationConfig }>('/api/jira/config', {
        projectMappings: draft.projectMappings,
        defaultDirectory: draft.defaultDirectory,
        appBaseUrl: draft.appBaseUrl,
        updates: draft.updates,
        issueListener: draft.issueListener,
      }, 'PUT');
      setDraft(result.config);
      setDirty(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const startFromIssue = async () => {
    setStarting(true);
    setStartError(null);
    setStartResult(null);
    try {
      const result = await postJson<JiraStartResult>('/api/jira/sessions', { issueKey });
      setStartResult(result);
      setIssueKey('');
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  const fieldLabelClass = 'text-xs font-medium text-foreground';
  const helperClass = 'text-[11px] text-muted-foreground';

  const renderConnectForm = () => (
    <div className="space-y-3">
      <p className={helperClass}>{t('settings.integrations.jira.connect.description')}</p>
      <div className="space-y-1">
        <div className={fieldLabelClass}>{t('settings.integrations.jira.connect.deployment')}</div>
        <Select value={deployment} onValueChange={(next) => setDeployment(next === 'server' ? 'server' : 'cloud')}>
          <SelectTrigger aria-label={t('settings.integrations.jira.connect.deployment')} className="h-8 w-full max-w-[24rem]">
            <SelectValue>
              {(selected) => (selected === 'server'
                ? t('settings.integrations.jira.connect.deploymentServer')
                : t('settings.integrations.jira.connect.deploymentCloud'))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cloud">{t('settings.integrations.jira.connect.deploymentCloud')}</SelectItem>
            <SelectItem value="server">{t('settings.integrations.jira.connect.deploymentServer')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <div className={fieldLabelClass}>{t('settings.integrations.jira.connect.baseUrl')}</div>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={deployment === 'cloud' ? 'https://your-site.atlassian.net' : 'https://jira.your-company.com'}
          aria-label={t('settings.integrations.jira.connect.baseUrl')}
          className="h-8 max-w-[24rem]"
        />
      </div>
      {deployment === 'cloud' ? (
        <div className="space-y-1">
          <div className={fieldLabelClass}>{t('settings.integrations.jira.connect.email')}</div>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-label={t('settings.integrations.jira.connect.email')}
            className="h-8 max-w-[24rem]"
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <div className={fieldLabelClass}>
          {deployment === 'cloud'
            ? t('settings.integrations.jira.connect.apiToken')
            : t('settings.integrations.jira.connect.pat')}
        </div>
        <Input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          aria-label={deployment === 'cloud'
            ? t('settings.integrations.jira.connect.apiToken')
            : t('settings.integrations.jira.connect.pat')}
          className="h-8 max-w-[24rem]"
        />
        <p className={helperClass}>
          {deployment === 'cloud'
            ? t('settings.integrations.jira.connect.apiTokenHelp')
            : t('settings.integrations.jira.connect.patHelp')}
        </p>
      </div>
      {connectError ? <p className="text-[11px] text-[var(--status-error)]">{connectError}</p> : null}
      <Button
        type="button"
        variant="default"
        size="sm"
        disabled={connecting || !baseUrl.trim() || !apiToken.trim() || (deployment === 'cloud' && !email.trim())}
        onClick={() => void connect()}
      >
        {connecting
          ? t('settings.integrations.jira.connect.connecting')
          : t('settings.integrations.jira.connect.connect')}
      </Button>
    </div>
  );

  const renderConnected = () => (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground truncate">
          {connection?.user?.displayName || connection?.email || connection?.baseUrl}
        </div>
        <div className={`${helperClass} truncate`}>
          {connection?.baseUrl}
          {' · '}
          {connection?.deployment === 'cloud'
            ? t('settings.integrations.jira.connect.deploymentCloud')
            : t('settings.integrations.jira.connect.deploymentServer')}
        </div>
      </div>
      <Button type="button" variant="outline" size="xs" onClick={() => void disconnect()}>
        {t('settings.integrations.jira.connect.disconnect')}
      </Button>
    </div>
  );

  const renderMappings = (current: JiraIntegrationConfig) => (
    <div className="space-y-2">
      <div className={fieldLabelClass}>{t('settings.integrations.jira.mappings.title')}</div>
      <p className={helperClass}>{t('settings.integrations.jira.mappings.description')}</p>
      {current.projectMappings.map((mapping, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={mapping.projectKey}
            onChange={(e) => updateDraft((c) => ({
              ...c,
              projectMappings: c.projectMappings.map((m, i) => (i === index
                ? { ...m, projectKey: e.target.value.toUpperCase() }
                : m)),
            }))}
            placeholder={t('settings.integrations.jira.mappings.keyPlaceholder')}
            aria-label={t('settings.integrations.jira.mappings.keyAria')}
            className="h-8 w-32"
          />
          <div className="flex-1 min-w-0">
            <DirectorySelect
              value={mapping.directory || null}
              onChange={(next) => updateDraft((c) => ({
                ...c,
                projectMappings: c.projectMappings.map((m, i) => (i === index
                  ? { ...m, directory: next ?? '' }
                  : m)),
              }))}
              options={directoryOptions}
              allowNone={false}
              noneLabel={t('settings.integrations.jira.mappings.directoryPlaceholder')}
              ariaLabel={t('settings.integrations.jira.mappings.directoryAria')}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t('settings.integrations.jira.mappings.removeAria')}
            onClick={() => updateDraft((c) => ({
              ...c,
              projectMappings: c.projectMappings.filter((_, i) => i !== index),
            }))}
          >
            {t('settings.integrations.jira.mappings.remove')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => updateDraft((c) => ({
          ...c,
          projectMappings: [...c.projectMappings, { projectKey: '', directory: directoryOptions[0]?.path ?? '' }],
        }))}
      >
        {t('settings.integrations.jira.mappings.add')}
      </Button>
      <div className="space-y-1 pt-1">
        <div className={fieldLabelClass}>{t('settings.integrations.jira.mappings.defaultDirectory')}</div>
        <p className={helperClass}>{t('settings.integrations.jira.mappings.defaultDirectoryHelp')}</p>
        <div className="max-w-[24rem]">
          <DirectorySelect
            value={current.defaultDirectory}
            onChange={(next) => updateDraft((c) => ({ ...c, defaultDirectory: next }))}
            options={directoryOptions}
            allowNone
            noneLabel={t('settings.integrations.jira.mappings.noDefault')}
            ariaLabel={t('settings.integrations.jira.mappings.defaultDirectoryAria')}
          />
        </div>
      </div>
    </div>
  );

  const updateToggle = (key: keyof JiraIntegrationConfig['updates'], labelKey: Parameters<typeof t>[0]) => {
    if (!draft) return null;
    return (
      <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
        <Checkbox
          checked={draft.updates[key]}
          onChange={(checked) => updateDraft((c) => ({
            ...c,
            updates: { ...c.updates, [key]: checked },
          }))}
          ariaLabel={t(labelKey)}
        />
        {t(labelKey)}
      </label>
    );
  };

  const renderConfig = (current: JiraIntegrationConfig) => (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className={fieldLabelClass}>{t('settings.integrations.jira.appBaseUrl.label')}</div>
        <p className={helperClass}>{t('settings.integrations.jira.appBaseUrl.help')}</p>
        <Input
          value={current.appBaseUrl ?? ''}
          onChange={(e) => updateDraft((c) => ({ ...c, appBaseUrl: e.target.value || null }))}
          placeholder="https://openchamber.your-company.com"
          aria-label={t('settings.integrations.jira.appBaseUrl.label')}
          className="h-8 max-w-[24rem]"
        />
      </div>

      {renderMappings(current)}

      <div className="space-y-1.5">
        <div className={fieldLabelClass}>{t('settings.integrations.jira.updates.title')}</div>
        <p className={helperClass}>{t('settings.integrations.jira.updates.description')}</p>
        {updateToggle('started', 'settings.integrations.jira.updates.started')}
        {updateToggle('completed', 'settings.integrations.jira.updates.completed')}
        {updateToggle('failed', 'settings.integrations.jira.updates.failed')}
        {updateToggle('attention', 'settings.integrations.jira.updates.attention')}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className={fieldLabelClass}>{t('settings.integrations.jira.listener.title')}</div>
            <p className={helperClass}>{t('settings.integrations.jira.listener.description')}</p>
          </div>
          <Switch
            checked={current.issueListener.enabled}
            onCheckedChange={(checked: boolean) => updateDraft((c) => ({
              ...c,
              issueListener: { ...c.issueListener, enabled: checked },
            }))}
            aria-label={t('settings.integrations.jira.listener.title')}
          />
        </div>
        {current.issueListener.enabled ? (
          <div className="space-y-2 pl-0.5">
            <div className="space-y-1">
              <div className={fieldLabelClass}>{t('settings.integrations.jira.listener.triggerLabel')}</div>
              <Input
                value={current.issueListener.triggerLabel}
                onChange={(e) => updateDraft((c) => ({
                  ...c,
                  issueListener: { ...c.issueListener, triggerLabel: e.target.value },
                }))}
                aria-label={t('settings.integrations.jira.listener.triggerLabel')}
                className="h-8 max-w-[16rem]"
              />
              <p className={helperClass}>{t('settings.integrations.jira.listener.triggerLabelHelp')}</p>
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
              <Checkbox
                checked={current.issueListener.removeTriggerLabel}
                onChange={(checked) => updateDraft((c) => ({
                  ...c,
                  issueListener: { ...c.issueListener, removeTriggerLabel: checked },
                }))}
                ariaLabel={t('settings.integrations.jira.listener.removeLabel')}
              />
              {t('settings.integrations.jira.listener.removeLabel')}
            </label>
          </div>
        ) : null}
      </div>

      {saveError ? <p className="text-[11px] text-[var(--status-error)]">{saveError}</p> : null}
      <Button
        type="button"
        variant="default"
        size="sm"
        disabled={!dirty || saving}
        onClick={() => void saveConfig()}
      >
        {saving ? t('settings.integrations.jira.config.saving') : t('settings.integrations.jira.config.save')}
      </Button>
    </div>
  );

  const renderStartFromIssue = () => (
    <div className="space-y-2">
      <div className={fieldLabelClass}>{t('settings.integrations.jira.start.title')}</div>
      <p className={helperClass}>{t('settings.integrations.jira.start.description')}</p>
      <div className="flex items-center gap-2">
        <Input
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value.toUpperCase())}
          placeholder="PROJ-123"
          aria-label={t('settings.integrations.jira.start.issueKeyAria')}
          className="h-8 w-40"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && issueKey.trim() && !starting) void startFromIssue();
          }}
        />
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={starting || !issueKey.trim()}
          onClick={() => void startFromIssue()}
        >
          {starting ? t('settings.integrations.jira.start.starting') : t('settings.integrations.jira.start.start')}
        </Button>
      </div>
      {startError ? <p className="text-[11px] text-[var(--status-error)]">{startError}</p> : null}
      {startResult ? (
        <div className="rounded-lg border border-border bg-background px-3 py-2 space-y-1">
          <div className="text-xs text-foreground">
            {t('settings.integrations.jira.start.started', { issueKey: startResult.issue.key })}
          </div>
          {startResult.sessionUrl ? (
            <a
              href={startResult.sessionUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-[var(--interactive-selection-text)] underline break-all"
            >
              {startResult.sessionUrl}
            </a>
          ) : (
            <div className={helperClass}>{startResult.sessionId}</div>
          )}
          {!startResult.promptDispatched ? (
            <div className="text-[11px] text-[var(--status-warning)]">
              {t('settings.integrations.jira.start.promptNotDispatched')}
            </div>
          ) : null}
          {startResult.linkage.errors.length > 0 ? (
            <div className="text-[11px] text-[var(--status-warning)]">
              {startResult.linkage.errors.join(' · ')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div data-settings-item="integrations.jira" className="space-y-4">
      <div>
        <h3 className={`typography-ui-label font-semibold ${JIRA_BRAND_CLASS}`}>
          {t('settings.integrations.jira.title')}
        </h3>
        <p className={helperClass}>{t('settings.integrations.jira.description')}</p>
      </div>

      {loading ? (
        <p className={helperClass}>{t('settings.integrations.jira.loading')}</p>
      ) : (
        <>
          {loadError ? <p className="text-[11px] text-[var(--status-error)]">{loadError}</p> : null}
          {connection ? renderConnected() : renderConnectForm()}
          {connection && draft ? (
            <>
              {renderConfig(draft)}
              {renderStartFromIssue()}
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
