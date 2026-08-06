import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.OPENCHAMBER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), `openchamber-jira-config-${crypto.randomBytes(4).toString('hex')}-`),
);

const {
  getJiraIntegrationConfig,
  updateJiraIntegrationConfig,
  resolveDirectoryForJiraProject,
  normalizeJiraProjectKey,
  JIRA_CONFIG_FILE,
  JIRA_LISTENER_MIN_INTERVAL_MS,
  JIRA_LISTENER_DEFAULT_INTERVAL_MS,
  JIRA_DEFAULT_TRIGGER_LABEL,
} = await import('./config.js');

const reset = () => {
  if (fs.existsSync(JIRA_CONFIG_FILE)) fs.unlinkSync(JIRA_CONFIG_FILE);
};

describe('Jira integration config', () => {
  beforeEach(reset);

  it('returns safe defaults when nothing is stored', () => {
    const config = getJiraIntegrationConfig();
    expect(config.projectMappings).toEqual([]);
    expect(config.defaultDirectory).toBeNull();
    expect(config.appBaseUrl).toBeNull();
    expect(config.updates).toEqual({ started: true, completed: true, failed: true, attention: true });
    expect(config.issueListener).toEqual({
      enabled: false,
      triggerLabel: JIRA_DEFAULT_TRIGGER_LABEL,
      removeTriggerLabel: true,
      intervalMs: JIRA_LISTENER_DEFAULT_INTERVAL_MS,
    });
  });

  it('merges partial updates without dropping other sections', () => {
    updateJiraIntegrationConfig({
      projectMappings: [{ projectKey: 'proj', directory: '/repo/a' }],
    });
    const config = updateJiraIntegrationConfig({ updates: { completed: false } });
    expect(config.projectMappings).toEqual([{ projectKey: 'PROJ', directory: '/repo/a' }]);
    expect(config.updates.completed).toBe(false);
    expect(config.updates.failed).toBe(true);
  });

  it('drops invalid mappings and duplicate project keys', () => {
    const config = updateJiraIntegrationConfig({
      projectMappings: [
        { projectKey: 'ABC', directory: '/one' },
        { projectKey: 'abc', directory: '/two' },
        { projectKey: '1BAD', directory: '/three' },
        { projectKey: 'OK', directory: '' },
      ],
    });
    expect(config.projectMappings).toEqual([{ projectKey: 'ABC', directory: '/one' }]);
  });

  it('clamps the listener interval and rejects unusable trigger labels', () => {
    const config = updateJiraIntegrationConfig({
      issueListener: { enabled: true, intervalMs: 1, triggerLabel: 'has space' },
    });
    expect(config.issueListener.intervalMs).toBe(JIRA_LISTENER_MIN_INTERVAL_MS);
    expect(config.issueListener.triggerLabel).toBe(JIRA_DEFAULT_TRIGGER_LABEL);
    expect(config.issueListener.enabled).toBe(true);
  });

  it('normalizes the app base URL and rejects invalid values', () => {
    expect(updateJiraIntegrationConfig({ appBaseUrl: 'https://chamber.corp.example/' }).appBaseUrl)
      .toBe('https://chamber.corp.example');
    expect(updateJiraIntegrationConfig({ appBaseUrl: 'not-a-url' }).appBaseUrl).toBeNull();
  });

  it('treats malformed stored config as defaults instead of failing', () => {
    fs.writeFileSync(JIRA_CONFIG_FILE, '{oops', 'utf8');
    expect(getJiraIntegrationConfig().projectMappings).toEqual([]);
  });
});

describe('resolveDirectoryForJiraProject', () => {
  beforeEach(reset);

  it('prefers an explicit mapping over the default directory', () => {
    const config = updateJiraIntegrationConfig({
      projectMappings: [{ projectKey: 'ABC', directory: '/mapped' }],
      defaultDirectory: '/default',
    });
    expect(resolveDirectoryForJiraProject(config, 'ABC')).toBe('/mapped');
    expect(resolveDirectoryForJiraProject(config, 'abc')).toBe('/mapped');
    expect(resolveDirectoryForJiraProject(config, 'OTHER')).toBe('/default');
  });

  it('returns null when nothing applies', () => {
    const config = getJiraIntegrationConfig();
    expect(resolveDirectoryForJiraProject(config, 'ABC')).toBeNull();
  });
});

describe('normalizeJiraProjectKey', () => {
  it('uppercases valid keys and rejects invalid ones', () => {
    expect(normalizeJiraProjectKey(' proj ')).toBe('PROJ');
    expect(normalizeJiraProjectKey('P2X')).toBe('P2X');
    expect(normalizeJiraProjectKey('2BAD')).toBeNull();
    expect(normalizeJiraProjectKey('')).toBeNull();
    expect(normalizeJiraProjectKey(null)).toBeNull();
  });
});
