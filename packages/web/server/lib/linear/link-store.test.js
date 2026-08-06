import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LinearLinkStore } from './link-store.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-links-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createStore() {
  return new LinearLinkStore({ filePath: path.join(tmpDir, 'links.json') });
}

const LINK = {
  issueId: 'issue-1',
  issueIdentifier: 'ENG-1',
  issueTitle: 'Fix login',
  issueUrl: 'https://linear.app/acme/issue/ENG-1/fix-login',
  teamId: 'team-1',
  teamKey: 'ENG',
  sessionId: 'ses_abc',
  directory: '/repo',
  projectId: 'proj-1',
};

describe('LinearLinkStore', () => {
  it('upserts and looks up by issue and session id', () => {
    const store = createStore();
    store.upsert(LINK);
    expect(store.getByIssueId('issue-1')?.sessionId).toBe('ses_abc');
    expect(store.getBySessionId('ses_abc')?.issueIdentifier).toBe('ENG-1');
    expect(store.getByIssueId('missing')).toBeNull();
  });

  it('replaces an existing link for the same issue', () => {
    const store = createStore();
    store.upsert(LINK);
    store.upsert({ ...LINK, sessionId: 'ses_new' });
    expect(store.list()).toHaveLength(1);
    expect(store.getByIssueId('issue-1')?.sessionId).toBe('ses_new');
  });

  it('transitions status once per distinct status', () => {
    const store = createStore();
    store.upsert(LINK);
    expect(store.transitionStatus('ses_abc', 'completed')?.lastStatus).toBe('completed');
    // Repeated identical status is suppressed so callers do not double-post.
    expect(store.transitionStatus('ses_abc', 'completed')).toBeNull();
    expect(store.transitionStatus('ses_abc', 'failed')?.lastStatus).toBe('failed');
    expect(store.transitionStatus('unknown-session', 'completed')).toBeNull();
    expect(store.transitionStatus('ses_abc', 'not-a-status')).toBeNull();
  });

  it('removes links by issue id', () => {
    const store = createStore();
    store.upsert(LINK);
    expect(store.remove('issue-1')).toBe(true);
    expect(store.remove('issue-1')).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('treats a corrupt file as empty instead of failing', () => {
    const filePath = path.join(tmpDir, 'links.json');
    fs.writeFileSync(filePath, 'nope', 'utf8');
    const store = new LinearLinkStore({ filePath });
    expect(store.list()).toEqual([]);
    store.upsert(LINK);
    expect(store.list()).toHaveLength(1);
  });
});
