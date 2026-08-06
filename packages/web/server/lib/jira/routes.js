import express from 'express';
import {
  getJiraConnection,
  setJiraConnection,
  clearJiraConnection,
  normalizeJiraBaseUrl,
  JIRA_DEPLOYMENT_CLOUD,
  JIRA_DEPLOYMENT_SERVER,
} from './auth.js';
import { getJiraIntegrationConfig, updateJiraIntegrationConfig } from './config.js';
import { createJiraClient, summarizeJiraUser, JiraApiError } from './client.js';
import { buildJiraIssueUrl } from './issue-context.js';
import { normalizeJiraIssueKey } from './session-start.js';
import { listJiraSessionLinks } from './links.js';

const httpStatusForError = (error) => {
  if (error instanceof JiraApiError) {
    if (error.code === 'auth_invalid') return 401;
    if (error.code === 'permission_denied') return 403;
    if (error.code === 'not_found') return 404;
    if (error.code === 'network_error') return 502;
    if (error.status >= 400 && error.status < 600) return error.status;
    return 400;
  }
  const status = Number(error?.statusCode);
  return Number.isFinite(status) && status >= 400 && status < 600 ? status : 500;
};

const sendError = (res, error, fallback) => {
  const status = httpStatusForError(error);
  return res.status(status).json({
    error: error?.message || fallback,
    ...(error instanceof JiraApiError ? { code: error.code } : {}),
  });
};

const requestOrigin = (req) => {
  const forwardedProto = typeof req.headers?.['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : '';
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  const host = typeof req.headers?.host === 'string' ? req.headers.host.trim() : '';
  if (!host) return null;
  return `${protocol}://${host}`;
};

const connectionSummary = (connection) => (connection
  ? {
    deployment: connection.deployment,
    baseUrl: connection.baseUrl,
    email: connection.email,
    user: connection.user,
  }
  : null);

export function registerJiraRoutes(app, { sessionStarter } = {}) {
  const json = express.json({ limit: '1mb' });

  app.get('/api/jira/status', (_req, res) => {
    try {
      const connection = getJiraConnection();
      return res.json({
        connected: Boolean(connection),
        connection: connectionSummary(connection),
        config: getJiraIntegrationConfig(),
      });
    } catch (error) {
      console.error('Failed to get Jira status:', error);
      return sendError(res, error, 'Failed to get Jira status');
    }
  });

  app.post('/api/jira/connect', json, async (req, res) => {
    try {
      const deployment = req.body?.deployment === JIRA_DEPLOYMENT_SERVER
        ? JIRA_DEPLOYMENT_SERVER
        : JIRA_DEPLOYMENT_CLOUD;
      const baseUrl = normalizeJiraBaseUrl(req.body?.baseUrl);
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const apiToken = typeof req.body?.apiToken === 'string' ? req.body.apiToken.trim() : '';

      if (!baseUrl) {
        return res.status(400).json({ error: 'A valid Jira base URL is required', code: 'invalid_base_url' });
      }
      if (!apiToken) {
        return res.status(400).json({
          error: deployment === JIRA_DEPLOYMENT_CLOUD
            ? 'A Jira API token is required'
            : 'A personal access token is required',
          code: 'missing_credentials',
        });
      }
      if (deployment === JIRA_DEPLOYMENT_CLOUD && !email) {
        return res.status(400).json({
          error: 'The Atlassian account email is required for Jira Cloud',
          code: 'missing_credentials',
        });
      }

      // Validate the credentials before storing anything.
      const candidate = { deployment, baseUrl, email: email || null, apiToken };
      const myself = await createJiraClient(candidate).getMyself();
      const user = summarizeJiraUser(myself);
      if (!user) {
        return res.status(502).json({ error: 'Jira did not return a valid user for these credentials', code: 'jira_error' });
      }

      const stored = setJiraConnection({ ...candidate, user });
      return res.json({
        connected: true,
        connection: connectionSummary(stored),
        config: getJiraIntegrationConfig(),
      });
    } catch (error) {
      console.error('Failed to connect Jira:', error?.message || error);
      return sendError(res, error, 'Failed to connect Jira');
    }
  });

  app.delete('/api/jira/auth', (_req, res) => {
    try {
      const removed = clearJiraConnection();
      return res.json({ success: removed });
    } catch (error) {
      console.error('Failed to disconnect Jira:', error);
      return sendError(res, error, 'Failed to disconnect Jira');
    }
  });

  app.put('/api/jira/config', json, (req, res) => {
    try {
      const config = updateJiraIntegrationConfig(req.body && typeof req.body === 'object' ? req.body : {});
      return res.json({ config });
    } catch (error) {
      console.error('Failed to update Jira config:', error);
      return sendError(res, error, 'Failed to update Jira config');
    }
  });

  app.get('/api/jira/issue', async (req, res) => {
    try {
      const issueKey = normalizeJiraIssueKey(req.query?.key);
      if (!issueKey) {
        return res.status(400).json({ error: 'A valid issue key is required (for example PROJ-123)', code: 'invalid_issue_key' });
      }
      const connection = getJiraConnection();
      if (!connection) {
        return res.status(400).json({ error: 'Jira is not connected', code: 'not_connected' });
      }
      const issue = await createJiraClient(connection).getIssue(issueKey);
      const fields = issue?.fields || {};
      return res.json({
        issue: {
          key: issue?.key || issueKey,
          summary: typeof fields.summary === 'string' ? fields.summary : null,
          status: typeof fields.status?.name === 'string' ? fields.status.name : null,
          issueType: typeof fields.issuetype?.name === 'string' ? fields.issuetype.name : null,
          projectKey: typeof fields.project?.key === 'string' ? fields.project.key : null,
          projectName: typeof fields.project?.name === 'string' ? fields.project.name : null,
          url: buildJiraIssueUrl(connection.baseUrl, issue?.key || issueKey),
        },
      });
    } catch (error) {
      return sendError(res, error, 'Failed to fetch Jira issue');
    }
  });

  app.post('/api/jira/sessions', json, async (req, res) => {
    try {
      if (!sessionStarter) {
        return res.status(500).json({ error: 'Jira session starter is not configured' });
      }
      const result = await sessionStarter.startSessionFromIssue({
        issueKey: req.body?.issueKey,
        directory: typeof req.body?.directory === 'string' ? req.body.directory : undefined,
        agent: typeof req.body?.agent === 'string' ? req.body.agent : undefined,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
        requestOrigin: requestOrigin(req),
        source: 'api',
      });
      return res.json(result);
    } catch (error) {
      console.error('Failed to start session from Jira issue:', error?.message || error);
      return sendError(res, error, 'Failed to start session from Jira issue');
    }
  });

  app.get('/api/jira/links', (req, res) => {
    try {
      const sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId : null;
      const issueKey = normalizeJiraIssueKey(req.query?.issueKey) || null;
      let links = listJiraSessionLinks();
      if (sessionId) links = links.filter((link) => link.sessionId === sessionId);
      if (issueKey) links = links.filter((link) => link.issueKey === issueKey);
      return res.json({ links });
    } catch (error) {
      console.error('Failed to list Jira session links:', error);
      return sendError(res, error, 'Failed to list Jira session links');
    }
  });
}
