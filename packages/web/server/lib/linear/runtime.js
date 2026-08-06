import { LinearIntegrationStore } from './store.js';
import { LinearLinkStore } from './link-store.js';
import { createLinearClient, parseIssueReference, LinearApiError } from './client.js';
import { buildIssuePrompt, buildIssueSessionTitle } from './issue-prompt.js';

const LINEAR_POLL_INTERVAL_DEFAULT_MS = 60_000;
const POLL_INTERVAL_MIN_MS = 15_000;

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turn an OpenCode `session.error` payload into one short line for a Linear
 * comment. Mirrors the messenger bridge's intent (never dump raw JSON into an
 * external surface) without importing its Discord-specific renderer.
 */
export function formatSessionErrorForComment(raw) {
  const candidates = [
    raw?.error?.data?.message,
    raw?.error?.message,
    raw?.data?.message,
    raw?.message,
  ];
  for (const candidate of candidates) {
    const text = asNonEmptyString(candidate);
    if (text) return text.length > 280 ? `${text.slice(0, 280)}…` : text;
  }
  const name = asNonEmptyString(raw?.error?.name) ?? asNonEmptyString(raw?.name);
  return name ?? 'OpenCode session error';
}

/**
 * Linear integration runtime: owns connect/disconnect, settings, manual and
 * label-triggered session starts, issue↔session linkage, and lifecycle status
 * comments posted back to the issue.
 *
 * Sessions are created through the shared OpenChamber session service (the
 * same path the web UI and control API use), so model/agent defaults, project
 * validation, and prompt-landed confirmation behave identically everywhere.
 */
export function createLinearIntegrationRuntime({
  store = null,
  linkStore = null,
  client = null,
  sessionService,
  globalEventHub = null,
  getAppBaseUrl = null,
  ensureEventStream = null,
  pollIntervalMs = LINEAR_POLL_INTERVAL_DEFAULT_MS,
  logger = console,
} = {}) {
  const integrationStore = store ?? new LinearIntegrationStore();
  const links = linkStore ?? new LinearLinkStore();
  const linearClient = client ?? createLinearClient({ getApiKey: () => integrationStore.getApiKey() });

  let pollTimer = null;
  let pollInFlight = false;
  let unsubscribeEvents = null;
  const startsInFlight = new Set();

  function buildSessionUrl(sessionId) {
    const settings = integrationStore.getSettings();
    const base =
      settings.linkBaseUrl ??
      (typeof getAppBaseUrl === 'function' ? asNonEmptyString(getAppBaseUrl()) : null) ??
      'http://127.0.0.1:9384';
    return `${base.replace(/\/+$/, '')}/?session=${encodeURIComponent(sessionId)}`;
  }

  function getStatus() {
    const state = integrationStore.read();
    return {
      connected: Boolean(state.apiKey),
      viewer: state.viewer,
      organization: state.organization,
      connectedAt: state.connectedAt,
      settings: state.settings,
      pollingActive: Boolean(pollTimer),
    };
  }

  async function connect({ apiKey }) {
    const key = asNonEmptyString(apiKey);
    if (!key) {
      const error = new Error('apiKey is required');
      error.statusCode = 400;
      throw error;
    }
    // Validate before persisting so a bad key never replaces a working one.
    const { viewer, organization } = await linearClient.fetchViewer({ apiKeyOverride: key });
    integrationStore.setAuth({ apiKey: key, viewer, organization });
    applySettingsSideEffects();
    return getStatus();
  }

  function disconnect() {
    stopPolling();
    integrationStore.clearAuth();
    return getStatus();
  }

  function updateSettings(partial) {
    const settings = integrationStore.updateSettings(partial);
    applySettingsSideEffects();
    return settings;
  }

  async function listTeams() {
    return linearClient.listTeams();
  }

  function listLinks() {
    return links.list();
  }

  function removeLink(issueId) {
    return links.remove(issueId);
  }

  function resolveProjectForIssue(issue, { projectId = null } = {}) {
    const explicit = asNonEmptyString(projectId);
    if (explicit) return explicit;
    const settings = integrationStore.getSettings();
    const teamId = asNonEmptyString(issue?.team?.id);
    if (teamId) {
      const mapping = settings.teamMappings.find((entry) => entry.teamId === teamId);
      if (mapping) return mapping.projectId;
    }
    return settings.defaultProjectId;
  }

  /**
   * Start an OpenChamber session from a Linear issue.
   *
   * Partial-failure contract: once the session exists it is always linked
   * locally, even when posting the link back to Linear fails — the response
   * carries `linkback` flags so callers can surface what did not land. An
   * already-linked issue is rejected (409) instead of silently duplicated.
   */
  async function startSessionFromIssue({ issue: issueInput, projectId = null, trustedRef = false } = {}) {
    // `parseIssueReference` sanitizes *user input* (pasted identifiers/URLs).
    // The poller passes ids straight from the Linear API — those are already
    // trusted and must not be rejected by the input-shape heuristics.
    const issueRef = trustedRef ? asNonEmptyString(issueInput) : parseIssueReference(issueInput);
    if (!issueRef) {
      const error = new Error('A Linear issue id, identifier (e.g. ENG-123), or issue URL is required');
      error.statusCode = 400;
      throw error;
    }

    const issue = await linearClient.fetchIssue(issueRef);
    if (!issue?.id) {
      const error = new Error(`Linear issue "${issueRef}" was not found`);
      error.statusCode = 404;
      throw error;
    }

    const existing = links.getByIssueId(issue.id);
    if (existing) {
      const error = new Error(
        `Issue ${existing.issueIdentifier ?? issue.identifier} is already linked to session ${existing.sessionId}`,
      );
      error.statusCode = 409;
      error.link = existing;
      throw error;
    }

    if (startsInFlight.has(issue.id)) {
      const error = new Error(`A session is already being started for ${issue.identifier}`);
      error.statusCode = 409;
      throw error;
    }
    startsInFlight.add(issue.id);
    try {
      const resolvedProjectId = resolveProjectForIssue(issue, { projectId });
      if (!resolvedProjectId) {
        const error = new Error(
          `No OpenChamber project is mapped for team "${issue?.team?.key ?? 'unknown'}" — set a default project or a team mapping in Settings → Integrations → Linear`,
        );
        error.statusCode = 400;
        throw error;
      }

      ensureSubscribed();
      try {
        await ensureEventStream?.();
      } catch {
        // The event stream is needed for status comments only; session start
        // must not fail because of it.
      }

      const created = await sessionService.create({
        projectId: resolvedProjectId,
        title: buildIssueSessionTitle(issue),
        prompt: buildIssuePrompt(issue),
      });

      const link = links.upsert({
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
        issueTitle: issue.title ?? null,
        issueUrl: issue.url ?? null,
        teamId: issue.team?.id ?? null,
        teamKey: issue.team?.key ?? null,
        sessionId: created.sessionId,
        directory: created.directory ?? null,
        projectId: resolvedProjectId,
        createdAt: Date.now(),
        lastStatus: 'started',
        lastStatusAt: Date.now(),
      });

      const sessionUrl = buildSessionUrl(created.sessionId);
      const linkback = { attached: false, commented: false, error: null };
      try {
        await linearClient.createAttachment({
          issueId: issue.id,
          title: 'OpenChamber session',
          subtitle: buildIssueSessionTitle(issue),
          url: sessionUrl,
        });
        linkback.attached = true;
      } catch (error) {
        linkback.error = error?.message ?? String(error);
        logger.warn?.('[Linear] Failed to attach session link to issue:', linkback.error);
      }
      if (integrationStore.getSettings().postStatusUpdates) {
        try {
          await linearClient.createComment({
            issueId: issue.id,
            body: `**OpenChamber** started working on this issue.\n\n[Open the session](${sessionUrl})`,
          });
          linkback.commented = true;
        } catch (error) {
          linkback.error = linkback.error ?? (error?.message ?? String(error));
          logger.warn?.('[Linear] Failed to post start comment:', error?.message ?? error);
        }
      }

      return {
        issue: {
          id: issue.id,
          identifier: issue.identifier ?? null,
          title: issue.title ?? null,
          url: issue.url ?? null,
        },
        sessionId: created.sessionId,
        directory: created.directory ?? null,
        sessionUrl,
        promptDispatched: created.promptDispatched === true,
        link,
        linkback,
      };
    } finally {
      startsInFlight.delete(issue.id);
    }
  }

  // --- Lifecycle status comments -----------------------------------------

  async function postStatusComment(link, status, body) {
    try {
      await linearClient.createComment({ issueId: link.issueId, body });
    } catch (error) {
      logger.warn?.(
        `[Linear] Failed to post ${status} comment for ${link.issueIdentifier ?? link.issueId}:`,
        error?.message ?? error,
      );
    }
  }

  async function handleGlobalEvent(normalized) {
    const payload = normalized?.payload ?? normalized;
    if (!payload || typeof payload !== 'object') return;
    const type = payload.type ?? payload.event ?? null;
    if (
      type !== 'session.idle' &&
      type !== 'session.error' &&
      type !== 'permission.asked' &&
      type !== 'question.asked'
    ) {
      return;
    }
    if (!integrationStore.getSettings().postStatusUpdates) return;
    const props = payload.properties ?? payload.props ?? payload;
    const sessionId = props?.sessionID ?? props?.sessionId ?? null;
    if (!sessionId) return;

    if (type === 'session.idle') {
      const link = links.transitionStatus(sessionId, 'completed');
      if (!link) return;
      await postStatusComment(
        link,
        'completed',
        `**OpenChamber** finished a run on this issue.\n\n[Open the session](${buildSessionUrl(sessionId)}) to review the result.`,
      );
      return;
    }
    if (type === 'session.error') {
      const link = links.transitionStatus(sessionId, 'failed');
      if (!link) return;
      const errText = formatSessionErrorForComment(props);
      await postStatusComment(
        link,
        'failed',
        `**OpenChamber** hit an error on this issue: ${errText}\n\n[Open the session](${buildSessionUrl(sessionId)}) to investigate.`,
      );
      return;
    }
    // permission.asked / question.asked — the session is blocked on a human.
    const link = links.transitionStatus(sessionId, 'attention');
    if (!link) return;
    await postStatusComment(
      link,
      'attention',
      `**OpenChamber** needs your attention on this issue (the agent asked a question or requested permission).\n\n[Open the session](${buildSessionUrl(sessionId)}) to respond.`,
    );
  }

  function ensureSubscribed() {
    if (unsubscribeEvents || !globalEventHub) return;
    unsubscribeEvents = globalEventHub.subscribeEvent((normalized) => {
      void handleGlobalEvent(normalized).catch((error) => {
        logger.warn?.('[Linear] Lifecycle event handling failed:', error?.message ?? error);
      });
    });
  }

  // --- Label-trigger polling ----------------------------------------------

  async function pollOnce() {
    if (pollInFlight) return { started: [], skipped: true };
    const state = integrationStore.read();
    if (!state.apiKey || !state.settings.autoStartEnabled) return { started: [] };
    pollInFlight = true;
    const started = [];
    try {
      const issues = await linearClient.listTriggerIssues({ label: state.settings.triggerLabel });
      for (const issue of issues) {
        if (!issue?.id || links.getByIssueId(issue.id) || startsInFlight.has(issue.id)) continue;
        try {
          const result = await startSessionFromIssue({ issue: issue.id, trustedRef: true });
          started.push(result);
          logger.log?.(
            `[Linear] Started session ${result.sessionId} from issue ${issue.identifier ?? issue.id}`,
          );
        } catch (error) {
          // One failed issue must not block the others; a 409 means another
          // caller linked it while this sweep was running.
          if (error?.statusCode !== 409) {
            logger.warn?.(
              `[Linear] Auto-start failed for ${issue.identifier ?? issue.id}:`,
              error?.message ?? error,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof LinearApiError && error.authFailed) {
        logger.warn?.('[Linear] Polling stopped — the API key was rejected');
        stopPolling();
      } else {
        logger.warn?.('[Linear] Trigger poll failed:', error?.message ?? error);
      }
    } finally {
      pollInFlight = false;
    }
    return { started };
  }

  function startPolling() {
    if (pollTimer) return;
    const interval = Math.max(POLL_INTERVAL_MIN_MS, pollIntervalMs);
    pollTimer = setInterval(() => {
      void pollOnce();
    }, interval);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    void pollOnce();
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function applySettingsSideEffects() {
    const state = integrationStore.read();
    if (state.apiKey && state.settings.autoStartEnabled) {
      ensureSubscribed();
      try {
        void ensureEventStream?.();
      } catch {
        // best-effort
      }
      startPolling();
    } else {
      stopPolling();
    }
    if (state.apiKey && state.settings.postStatusUpdates) {
      ensureSubscribed();
    }
  }

  /** Boot entrypoint — resume polling/status watching from persisted state. */
  function start() {
    const state = integrationStore.read();
    if (!state.apiKey) return;
    // Existing links need status comments even when auto-start is off.
    if (state.settings.postStatusUpdates) {
      ensureSubscribed();
      try {
        void ensureEventStream?.();
      } catch {
        // best-effort
      }
    }
    if (state.settings.autoStartEnabled) startPolling();
  }

  function stop() {
    stopPolling();
    if (unsubscribeEvents) {
      try {
        unsubscribeEvents();
      } catch {
        // ignore
      }
      unsubscribeEvents = null;
    }
  }

  return {
    getStatus,
    connect,
    disconnect,
    updateSettings,
    listTeams,
    listLinks,
    removeLink,
    startSessionFromIssue,
    pollOnce,
    start,
    stop,
    /** Test seam — drive lifecycle events without an SSE stream. */
    _handleGlobalEvent: handleGlobalEvent,
  };
}
