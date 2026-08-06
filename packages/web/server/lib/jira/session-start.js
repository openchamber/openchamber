import { getJiraConnection } from './auth.js';
import { getJiraIntegrationConfig, resolveDirectoryForJiraProject } from './config.js';
import { createJiraClient, JiraApiError } from './client.js';
import { buildJiraIssuePrompt, buildJiraIssueUrl, buildJiraSessionTitle } from './issue-context.js';
import { recordJiraSessionLink } from './links.js';

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

export function normalizeJiraIssueKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  return ISSUE_KEY_PATTERN.test(key) ? key : null;
}

export function buildSessionWebUrl(appBaseUrl, sessionId) {
  if (!appBaseUrl || !sessionId) return null;
  return `${appBaseUrl}/?session=${encodeURIComponent(sessionId)}`;
}

const describeIssueFetchError = (error, issueKey) => {
  if (!(error instanceof JiraApiError)) return error;
  if (error.code === 'not_found' || error.code === 'permission_denied') {
    // Jira answers 404 for issues hidden by permissions, so both cases must
    // name permissions and private projects explicitly.
    return new JiraApiError(
      `Jira issue ${issueKey} was not found or is not visible to the connected Jira user. `
        + 'Check the issue key, issue permissions, and private project access.',
      { status: error.status, code: error.code },
    );
  }
  if (error.code === 'auth_invalid') {
    return new JiraApiError(
      'Jira rejected the stored credentials. Reconnect Jira in Settings.',
      { status: error.status, code: error.code },
    );
  }
  return error;
};

/**
 * Orchestrates issue-to-session initiation:
 * fetch issue -> resolve directory -> create session -> record + post linkage
 * -> arm lifecycle updates.
 *
 * Failure semantics: everything up to and including session creation fails the
 * whole operation with an explicit error. After the session exists, the local
 * link record is written first, then Jira-side linkage (remote link + comment)
 * is attempted; those failures are reported in the result instead of undoing
 * the session.
 */
export function createJiraSessionStarter({
  sessionService,
  statusUpdates = null,
  getConnection = getJiraConnection,
  getConfig = getJiraIntegrationConfig,
  createClient = createJiraClient,
  recordLink = recordJiraSessionLink,
}) {
  const startSessionFromIssue = async ({
    issueKey: rawIssueKey,
    directory: requestedDirectory,
    agent,
    model,
    requestOrigin = null,
    source = 'api',
  } = {}) => {
    const issueKey = normalizeJiraIssueKey(rawIssueKey);
    if (!issueKey) {
      throw new JiraApiError('A valid Jira issue key (for example PROJ-123) is required', {
        status: 400,
        code: 'invalid_issue_key',
      });
    }

    const connection = getConnection();
    if (!connection) {
      throw new JiraApiError('Jira is not connected. Connect Jira in Settings first.', {
        status: 400,
        code: 'not_connected',
      });
    }

    const client = createClient(connection);
    let issue;
    try {
      issue = await client.getIssue(issueKey);
    } catch (error) {
      throw describeIssueFetchError(error, issueKey);
    }
    if (!issue?.key || !issue?.fields) {
      throw new JiraApiError(`Jira returned an unexpected payload for issue ${issueKey}`, {
        status: 502,
        code: 'jira_error',
      });
    }

    const config = getConfig();
    const projectKey = typeof issue.fields?.project?.key === 'string' ? issue.fields.project.key : null;
    const directory = typeof requestedDirectory === 'string' && requestedDirectory.trim()
      ? requestedDirectory.trim()
      : resolveDirectoryForJiraProject(config, projectKey);
    if (!directory) {
      throw new JiraApiError(
        `No OpenChamber project is mapped for Jira project ${projectKey || '(unknown)'}. `
          + 'Add a project mapping or a default directory in the Jira settings.',
        { status: 400, code: 'no_project_mapping' },
      );
    }

    const title = buildJiraSessionTitle(issue);
    const prompt = buildJiraIssuePrompt({ issue, baseUrl: connection.baseUrl });

    // Throws with an explicit status when the directory is invalid, the
    // model/agent are unknown, or OpenCode rejects the session.
    const created = await sessionService.create({
      directory,
      title,
      prompt,
      ...(typeof agent === 'string' && agent ? { agent } : {}),
      ...(typeof model === 'string' && model ? { model } : {}),
    });

    const issueUrl = buildJiraIssueUrl(connection.baseUrl, issue.key);
    const issueSummary = typeof issue.fields?.summary === 'string' ? issue.fields.summary : null;

    const linkage = { recorded: false, remoteLinkCreated: false, commentPosted: false, errors: [] };
    try {
      recordLink({
        issueKey: issue.key,
        issueUrl,
        issueSummary,
        sessionId: created.sessionId,
        directory: created.directory,
        source,
      });
      linkage.recorded = true;
    } catch (error) {
      linkage.errors.push(`Failed to record local link: ${error?.message || error}`);
    }

    const appBaseUrl = config.appBaseUrl || requestOrigin;
    const sessionUrl = buildSessionWebUrl(appBaseUrl, created.sessionId);

    if (sessionUrl) {
      try {
        await client.createRemoteLink(issue.key, {
          globalId: `openchamber-session-${created.sessionId}`,
          url: sessionUrl,
          title: `OpenChamber session: ${title}`,
          summary: 'OpenChamber session working on this issue',
        });
        linkage.remoteLinkCreated = true;
      } catch (error) {
        linkage.errors.push(`Failed to create Jira remote link: ${error?.message || error}`);
      }
    } else {
      linkage.errors.push('No OpenChamber app base URL is configured, so no session link could be posted to Jira.');
    }

    if (config.updates.started) {
      const commentLines = [
        `OpenChamber started session "${title}" for this issue.`,
        sessionUrl ? `Open the session: ${sessionUrl}` : `Session id: ${created.sessionId}`,
      ];
      try {
        await client.addComment(issue.key, commentLines.join('\n'));
        linkage.commentPosted = true;
      } catch (error) {
        linkage.errors.push(`Failed to post Jira comment: ${error?.message || error}`);
      }
    }

    // Only watch sessions whose prompt actually landed — without a running
    // turn there is no lifecycle to report, and a stray idle event would post
    // a misleading "completed" update.
    if (statusUpdates && created.promptDispatched === true) {
      statusUpdates.watchSession({
        sessionId: created.sessionId,
        issueKey: issue.key,
        sessionUrl,
        title,
      });
    }

    return {
      sessionId: created.sessionId,
      directory: created.directory,
      title,
      sessionUrl,
      promptDispatched: created.promptDispatched === true,
      ...(created.promptError ? { promptError: created.promptError } : {}),
      issue: {
        key: issue.key,
        summary: issueSummary,
        url: issueUrl,
        projectKey,
      },
      linkage,
    };
  };

  return { startSessionFromIssue };
}
