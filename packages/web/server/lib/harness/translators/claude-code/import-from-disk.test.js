import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureSessionBindings,
  resetSessionBindings,
  getSessionBinding,
  listSessionBindings,
} from '../../session-bindings.js';
import {
  decodeClaudeProjectKey,
  importClaudeSessions,
  inspectClaudeSessionJsonl,
  listClaudeImportCandidates,
  resolveClaudeProjectsRoot,
} from './import-from-disk.js';

afterEach(() => {
  resetSessionBindings({ clearDisk: false });
  configureSessionBindings({ persist: false, load: true });
});

describe('decodeClaudeProjectKey', () => {
  it('decodes absolute posix and windows-style keys', () => {
    expect(decodeClaudeProjectKey('-Users-me-code-app')).toBe('/Users/me/code/app');
    expect(decodeClaudeProjectKey('C-Users-me-code-app')).toBe('C:/Users/me/code/app');
  });
});

describe('inspectClaudeSessionJsonl', () => {
  it('reads cwd and first user title from JSONL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-jsonl-'));
    const filePath = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: 'user',
        cwd: '/tmp/demo-project',
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the flaky test' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Sure' }] },
      }),
    ].join('\n'));

    const meta = inspectClaudeSessionJsonl(filePath);
    expect(meta.directory).toBe('/tmp/demo-project');
    expect(meta.title).toBe('Fix the flaky test');
    expect(meta.updatedAt).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips malformed lines without failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-bad-'));
    const filePath = path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl');
    fs.writeFileSync(filePath, [
      'not-json',
      JSON.stringify({ type: 'summary', summary: 'Auth refactor', cwd: '/repo' }),
    ].join('\n'));

    const meta = inspectClaudeSessionJsonl(filePath);
    expect(meta.title).toBe('Auth refactor');
    expect(meta.directory).toBe('/repo');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('listClaudeImportCandidates', () => {
  it('lists projects/sessions and marks already-imported ids', async () => {
    configureSessionBindings({ persist: false, load: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-root-'));
    const configDir = path.join(root, '.claude');
    const projectsRoot = path.join(configDir, 'projects');
    const projectKey = '-tmp-demo-project';
    const projectDir = path.join(projectsRoot, projectKey);
    fs.mkdirSync(projectDir, { recursive: true });

    const importedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const freshId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const projectPath = path.join(root, 'demo-project');
    fs.mkdirSync(projectPath, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, `${importedId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        cwd: projectPath,
        message: { role: 'user', content: 'Already imported chat' },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(projectDir, `${freshId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        cwd: projectPath,
        message: { role: 'user', content: 'Fresh chat' },
      })}\n`,
    );
    // Subagent transcript should be ignored.
    fs.writeFileSync(path.join(projectDir, 'agent-cccc.jsonl'), '{}\n');

    const { bindSession } = await import('../../session-bindings.js');
    bindSession({
      sessionId: 'ses_existing',
      harnessId: 'claude-code',
      directory: projectPath,
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      foreignSessionId: importedId,
    });

    const payload = await listClaudeImportCandidates({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: root,
      fs,
    });

    expect(payload.projectsRoot).toBe(projectsRoot);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0].directory).toBe(projectPath);
    expect(payload.projects[0].sessions).toHaveLength(2);
    const byId = Object.fromEntries(
      payload.projects[0].sessions.map((session) => [session.foreignSessionId, session]),
    );
    expect(byId[importedId].alreadyImported).toBe(true);
    expect(byId[freshId].alreadyImported).toBe(false);
    expect(byId[freshId].title).toBe('Fresh chat');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns empty projects when Claude config is missing (not failure)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-missing-'));
    const payload = await listClaudeImportCandidates({
      env: {},
      homeDir: root,
      fs,
    });
    expect(payload.projectsRoot).toBeNull();
    expect(payload.projects).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('importClaudeSessions', () => {
  it('imports, skips already-bound, and continues after failures', async () => {
    configureSessionBindings({ persist: false, load: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-run-'));
    const goodDir = path.join(root, 'good');
    fs.mkdirSync(goodDir, { recursive: true });

    const alreadyId = '11111111-1111-4111-8111-111111111111';
    const missingDirId = '22222222-2222-4222-8222-222222222222';
    const createFailId = '33333333-3333-4333-8333-333333333333';
    const okId = '44444444-4444-4444-8444-444444444444';

    const { bindSession } = await import('../../session-bindings.js');
    bindSession({
      sessionId: 'ses_old',
      harnessId: 'claude-code',
      directory: goodDir,
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      foreignSessionId: alreadyId,
    });

    let createCalls = 0;
    const result = await importClaudeSessions({
      sessions: [
        { foreignSessionId: alreadyId, directory: goodDir, title: 'Old' },
        { foreignSessionId: missingDirId, directory: path.join(root, 'missing'), title: 'Missing' },
        { foreignSessionId: createFailId, directory: goodDir, title: 'Boom' },
        { foreignSessionId: okId, directory: goodDir, title: 'New chat' },
      ],
      createSession: async (_directory, title) => {
        createCalls += 1;
        if (title === 'Boom') {
          throw new Error('create failed');
        }
        return `ses_${createCalls}`;
      },
      flush: () => {},
    });

    expect(result.summary).toEqual({ imported: 1, skipped: 1, failed: 2 });
    expect(result.results.map((row) => row.status || row.code)).toEqual([
      'skipped',
      'DIRECTORY_MISSING',
      'SESSION_CREATE_FAILED',
      'imported',
    ]);
    expect(getSessionBinding('ses_2')?.foreignSessionId).toBe(okId);
    expect(listSessionBindings().some((b) => b.foreignSessionId === okId)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('resolveClaudeProjectsRoot', () => {
  it('prefers CLAUDE_CONFIG_DIR', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-cfg-'));
    const configDir = path.join(root, 'custom');
    fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude', 'projects'), { recursive: true });

    expect(resolveClaudeProjectsRoot({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: root,
      fs,
    })).toBe(path.join(configDir, 'projects'));

    fs.rmSync(root, { recursive: true, force: true });
  });
});
