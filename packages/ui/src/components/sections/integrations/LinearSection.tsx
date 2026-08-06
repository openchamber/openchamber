import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  useLinearIntegrationStore,
  type LinearLinkStatus,
  type LinearSessionLink,
} from '@/stores/useLinearIntegrationStore';

/** Linear brand mark — intentional product color, not a theme token. */
const LINEAR_BRAND_CLASS = 'text-[#5E6AD2]';

const LINEAR_API_KEYS_URL = 'https://linear.app/settings/account/security';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

const selectClass =
  'h-8 min-w-[12rem] max-w-full rounded-md border border-[var(--interactive-border)] bg-background px-2 text-xs text-foreground disabled:opacity-50';

const STATUS_BADGE: Record<LinearLinkStatus, { className: string }> = {
  started: { className: 'bg-[var(--status-info)]/15 text-[var(--status-info)]' },
  completed: { className: 'bg-[var(--status-success)]/15 text-[var(--status-success)]' },
  failed: { className: 'bg-[var(--status-error)]/15 text-[var(--status-error)]' },
  attention: { className: 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]' },
};

function LinkStatusBadge({ status }: { status: LinearLinkStatus }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
        STATUS_BADGE[status].className,
      )}
    >
      {t(`settings.integrations.linear.links.status.${status}`)}
    </span>
  );
}

function LinearConnectCard({ onConnect }: { onConnect: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onConnect}
      data-settings-item="integrations.linear.connect"
      className="flex size-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Icon name="linear-app" className={cn('size-9', LINEAR_BRAND_CLASS)} />
      <span className="flex items-center gap-1 text-xs font-medium">
        <Icon name="add" className="size-3.5" />
        {t('settings.integrations.linear.connect')}
      </span>
      <span className="text-[10px] font-normal leading-snug text-muted-foreground/80">
        {t('settings.integrations.linear.connectHint')}
      </span>
    </button>
  );
}

function LinearConnectForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const connect = useLinearIntegrationStore((s) => s.connect);
  const busy = useLinearIntegrationStore((s) => s.busy);
  const error = useLinearIntegrationStore((s) => s.error);
  const clearError = useLinearIntegrationStore((s) => s.clearError);
  const [apiKey, setApiKey] = useState('');

  const handleConnect = async () => {
    if (!apiKey.trim() || busy) return;
    const ok = await connect(apiKey.trim());
    if (ok) {
      setApiKey('');
      onDone();
    }
  };

  return (
    <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <Icon name="linear-app" className={cn('size-5', LINEAR_BRAND_CLASS)} />
        <span className="text-sm font-semibold text-foreground">
          {t('settings.integrations.linear.connectTitle')}
        </span>
      </div>
      <div className="space-y-2">
        <label htmlFor="linear-api-key" className="text-xs font-medium text-foreground">
          {t('settings.integrations.linear.apiKeyLabel')}
        </label>
        <input
          id="linear-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (error) clearError();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleConnect();
          }}
          placeholder="lin_api_…"
          className={inputClass}
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('settings.integrations.linear.apiKeyHint')}
        </p>
        <a
          href={LINEAR_API_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--primary-base)] hover:underline"
        >
          <Icon name="external-link" className="size-3.5" />
          {t('settings.integrations.linear.openApiKeys')}
        </a>
      </div>
      {error && <p className="text-xs text-[var(--status-error)]">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!apiKey.trim() || busy} onClick={() => void handleConnect()}>
          {busy
            ? t('settings.integrations.linear.connecting')
            : t('settings.integrations.linear.connectAction')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('settings.integrations.linear.cancel')}
        </Button>
      </div>
    </div>
  );
}

function ProjectSelect({
  id,
  value,
  emptyLabel,
  onChange,
}: {
  id: string;
  value: string | null;
  emptyLabel: string;
  onChange: (projectId: string | null) => void;
}) {
  const projects = useProjectsStore((s) => s.projects);
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={selectClass}
    >
      <option value="">{emptyLabel}</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.label ?? project.path}
        </option>
      ))}
    </select>
  );
}

function LinkedIssueRow({ link }: { link: LinearSessionLink }) {
  const { t } = useI18n();
  const removeLink = useLinearIntegrationStore((s) => s.removeLink);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {link.issueUrl ? (
            <a
              href={link.issueUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs font-semibold text-[var(--primary-base)] hover:underline"
            >
              {link.issueIdentifier ?? link.issueId}
            </a>
          ) : (
            <span className="shrink-0 text-xs font-semibold text-foreground">
              {link.issueIdentifier ?? link.issueId}
            </span>
          )}
          <LinkStatusBadge status={link.lastStatus} />
        </div>
        {link.issueTitle && (
          <p className="truncate text-xs text-muted-foreground">{link.issueTitle}</p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0"
        onClick={() => {
          void useSessionUIStore.getState().setCurrentSession(link.sessionId, link.directory ?? null);
        }}
      >
        <Icon name="external-link" className="size-3.5" />
        {t('settings.integrations.linear.links.openSession')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => void removeLink(link.issueId)}
      >
        {t('settings.integrations.linear.links.unlink')}
      </Button>
    </div>
  );
}

function LinearConnectedCard() {
  const { t } = useI18n();
  const viewer = useLinearIntegrationStore((s) => s.viewer);
  const organization = useLinearIntegrationStore((s) => s.organization);
  const settings = useLinearIntegrationStore((s) => s.settings);
  const teams = useLinearIntegrationStore((s) => s.teams);
  const links = useLinearIntegrationStore((s) => s.links);
  const busy = useLinearIntegrationStore((s) => s.busy);
  const error = useLinearIntegrationStore((s) => s.error);
  const disconnect = useLinearIntegrationStore((s) => s.disconnect);
  const updateSettings = useLinearIntegrationStore((s) => s.updateSettings);
  const fetchTeams = useLinearIntegrationStore((s) => s.fetchTeams);
  const fetchLinks = useLinearIntegrationStore((s) => s.fetchLinks);
  const startFromIssue = useLinearIntegrationStore((s) => s.startFromIssue);

  const [issueInput, setIssueInput] = useState('');
  const [startFeedback, setStartFeedback] = useState<string | null>(null);
  const [triggerLabelDraft, setTriggerLabelDraft] = useState<string | null>(null);

  useEffect(() => {
    void fetchTeams();
    void fetchLinks();
  }, [fetchTeams, fetchLinks]);

  if (!settings) return null;

  const setTeamMapping = (teamId: string, projectId: string | null) => {
    const team = teams.find((entry) => entry.id === teamId) ?? null;
    const next = settings.teamMappings.filter((mapping) => mapping.teamId !== teamId);
    if (projectId) {
      next.push({
        teamId,
        teamKey: team?.key ?? null,
        teamName: team?.name ?? null,
        projectId,
      });
    }
    void updateSettings({ teamMappings: next });
  };

  const commitTriggerLabel = () => {
    if (triggerLabelDraft == null) return;
    const value = triggerLabelDraft.trim();
    setTriggerLabelDraft(null);
    if (value && value !== settings.triggerLabel) {
      void updateSettings({ triggerLabel: value });
    }
  };

  const handleStartFromIssue = async () => {
    const issue = issueInput.trim();
    if (!issue || busy) return;
    setStartFeedback(null);
    try {
      const result = await startFromIssue(issue);
      setIssueInput('');
      setStartFeedback(
        t('settings.integrations.linear.startIssue.success', {
          issue: result.issue.identifier ?? issue,
        }),
      );
    } catch {
      // The store keeps the error message; it renders below.
    }
  };

  const workspaceName = organization?.name ?? organization?.urlKey ?? null;

  return (
    <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-5 shadow-sm space-y-5">
      {/* Header — Linear mark + identity + Disconnect */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <Icon name="linear-app" className={cn('size-5 shrink-0', LINEAR_BRAND_CLASS)} />
          <span className="shrink-0 text-sm font-semibold text-foreground">Linear</span>
          <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--status-success)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--status-success)]">
            {t('settings.integrations.linear.status.connected')}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {[workspaceName, viewer?.name].filter(Boolean).join(' · ')}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal whitespace-nowrap shrink-0"
          onClick={() => void disconnect()}
        >
          {t('settings.integrations.linear.disconnect')}
        </Button>
      </div>

      {error && <p className="text-xs text-[var(--status-error)]">{error}</p>}

      {/* Project routing */}
      <div className="space-y-3" data-settings-item="integrations.linear.projects">
        <div>
          <h4 className="text-xs font-semibold text-foreground">
            {t('settings.integrations.linear.projects.title')}
          </h4>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('settings.integrations.linear.projects.info')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor="linear-default-project" className="text-muted-foreground">
            {t('settings.integrations.linear.defaultProject.label')}
          </label>
          <ProjectSelect
            id="linear-default-project"
            value={settings.defaultProjectId}
            emptyLabel={t('settings.integrations.linear.defaultProject.none')}
            onChange={(projectId) => void updateSettings({ defaultProjectId: projectId })}
          />
        </div>
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">
            {t('settings.integrations.linear.teamMappings.label')}
          </span>
          {teams.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/80">
              {t('settings.integrations.linear.teamMappings.empty')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {teams.map((team) => (
                <div key={team.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="min-w-[8rem] truncate text-foreground">
                    {team.name} <span className="text-muted-foreground">({team.key})</span>
                  </span>
                  <ProjectSelect
                    id={`linear-team-${team.id}`}
                    value={
                      settings.teamMappings.find((mapping) => mapping.teamId === team.id)
                        ?.projectId ?? null
                    }
                    emptyLabel={t('settings.integrations.linear.teamMappings.useDefault')}
                    onChange={(projectId) => setTeamMapping(team.id, projectId)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Auto-start + status updates */}
      <div className="space-y-3" data-settings-item="integrations.linear.autostart">
        <h4 className="text-xs font-semibold text-foreground">
          {t('settings.integrations.linear.autoStart.title')}
        </h4>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-foreground">
              {t('settings.integrations.linear.autoStart.label')}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('settings.integrations.linear.autoStart.info')}
            </p>
          </div>
          <Switch
            checked={settings.autoStartEnabled}
            onCheckedChange={(checked) => void updateSettings({ autoStartEnabled: checked })}
            aria-label={t('settings.integrations.linear.autoStart.label')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor="linear-trigger-label" className="text-muted-foreground">
            {t('settings.integrations.linear.triggerLabel.label')}
          </label>
          <input
            id="linear-trigger-label"
            type="text"
            value={triggerLabelDraft ?? settings.triggerLabel}
            onChange={(e) => setTriggerLabelDraft(e.target.value)}
            onBlur={commitTriggerLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTriggerLabel();
            }}
            className={cn(inputClass, 'h-8 w-44')}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-foreground">
              {t('settings.integrations.linear.statusUpdates.label')}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {t('settings.integrations.linear.statusUpdates.info')}
            </p>
          </div>
          <Switch
            checked={settings.postStatusUpdates}
            onCheckedChange={(checked) => void updateSettings({ postStatusUpdates: checked })}
            aria-label={t('settings.integrations.linear.statusUpdates.label')}
          />
        </div>
      </div>

      {/* Manual start from an issue */}
      <div className="space-y-2" data-settings-item="integrations.linear.startIssue">
        <h4 className="text-xs font-semibold text-foreground">
          {t('settings.integrations.linear.startIssue.title')}
        </h4>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={issueInput}
            onChange={(e) => setIssueInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleStartFromIssue();
            }}
            placeholder={t('settings.integrations.linear.startIssue.placeholder')}
            className={cn(inputClass, 'h-8 w-64')}
          />
          <Button
            type="button"
            size="sm"
            disabled={!issueInput.trim() || busy}
            onClick={() => void handleStartFromIssue()}
          >
            <Icon name="play" className="size-3.5" />
            {busy
              ? t('settings.integrations.linear.startIssue.starting')
              : t('settings.integrations.linear.startIssue.action')}
          </Button>
        </div>
        {startFeedback && (
          <p className="text-xs text-[var(--status-success)]">{startFeedback}</p>
        )}
      </div>

      {/* Linked issues */}
      <div className="space-y-2" data-settings-item="integrations.linear.links">
        <h4 className="text-xs font-semibold text-foreground">
          {t('settings.integrations.linear.links.title')}
        </h4>
        {links.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/80">
            {t('settings.integrations.linear.links.empty')}
          </p>
        ) : (
          <div className="space-y-1.5">
            {links.slice(0, 10).map((link) => (
              <LinkedIssueRow key={link.issueId} link={link} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Settings → Integrations → Linear.
 *
 * Connect a Linear workspace with a personal API key, route issue teams to
 * OpenChamber projects, start sessions from issues (manually or via the
 * trigger label), and see the issue ↔ session links.
 */
export const LinearSection: React.FC = () => {
  const hydrated = useLinearIntegrationStore((s) => s.hydrated);
  const connected = useLinearIntegrationStore((s) => s.connected);
  const refreshStatus = useLinearIntegrationStore((s) => s.refreshStatus);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  return (
    <div data-settings-item="integrations.linear">
      {!hydrated ? null : connected ? (
        <LinearConnectedCard />
      ) : connecting ? (
        <LinearConnectForm
          onDone={() => setConnecting(false)}
          onCancel={() => setConnecting(false)}
        />
      ) : (
        <LinearConnectCard onConnect={() => setConnecting(true)} />
      )}
    </div>
  );
};
