import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getMultiRunIdentity, withMultiRunMembership } from './identity';
import { startRunFusion } from './fusion';
import { buildMultiRunIndex } from './runs';

const group = { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' } as const;
const makeSession = (id: string, directory: string): Session => ({
  id, projectID: 'project', directory, title: id, model: { providerID: 'provider', id: 'model' },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1, idle: 2 }, outcome: 'succeeded',
});

function fixture(code: boolean) {
  const sessions = new Map<string, Session>();
  for (const id of ['a', 'b']) {
    const session = makeSession(id, code ? `/worktrees/${id}` : '/repo');
    session.metadata = withMultiRunMembership({}, {
      version: 1, sessionID: id, group, groupSlug: 'test', providerID: 'provider', modelID: 'model', role: 'run', guidance: `Keep ${id}'s tests`,
    });
    sessions.set(id, session);
  }
  const refs = new Map<string, string>();
  const prompts = new Map<string, string>([['a', 'Original task'], ['b', 'Original task']]);
  const replies = new Map<string, string>([['a', 'Result A'], ['b', 'Result B']]);
  const conversations = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>();
  const sent: Array<{ id: string; text: string; context: string[] }> = [];
  const createdDirectories: string[] = [];
  const projectPaths = new Map<string, string>();
  let failure: 'reply' | 'snapshot' | 'send' | null = null;
  const busy = new Set<string>();
  const io: NonNullable<Parameters<typeof startRunFusion>[1]> = {
    readSession: async (id) => {
      const session = sessions.get(id);
      if (!session) throw new Error('Missing source');
      return session;
    },
    readReply: async (id) => {
      if (failure === 'reply') throw new Error('reply read failed');
      return replies.get(id) ?? '';
    },
    readPrompt: async (id) => ({ messageId: `prompt-${id}`, text: prompts.get(id) ?? 'Fuse results', files: [] }),
    readConversation: async (id) => {
      if (failure === 'reply') throw new Error('Parent conversation unavailable');
      return conversations.get(id) ?? [];
    },
    locate: async (session) => ({ project: { id: 'project', path: projectPaths.get(session.id) ?? '/repo' }, worktree: code ? {
      path: session.directory, projectDirectory: '/repo', branch: session.id, label: session.id,
    } : null }),
    diffStat: async (directory) => createdDirectories.includes(directory)
      ? { files: 0, insertions: 0, deletions: 0 }
      : { files: 1, insertions: 5, deletions: 1 },
    snapshot: async (directory, { ref }) => {
      if (failure === 'snapshot') throw new Error('snapshot failed');
      const commit = `snapshot-${directory.split('/').pop()}-${refs.size}`;
      refs.set(ref, commit);
      return { ref, commit, head: 'start' };
    },
    rangeDiff: async () => ({ diff: 'source diff' }),
    setupCommands: async () => [], setupWait: async () => false,
    createWorktree: async (_project, input) => {
      const path = `/worktrees/${input.worktreeName}`;
      createdDirectories.push(path);
      return { path, projectDirectory: '/repo', branch: input.branchName ?? '', label: input.preferredName ?? '' };
    },
    waitBootstrap: async () => {}, startDirectory: async (_project, tree) => tree.path,
    renderPrompt: async () => 'Fuse results',
    createSession: async (input) => {
      const id = `fusion-${sessions.size}`;
      const session = makeSession(id, input.directory);
      session.metadata = withMultiRunMembership({}, { ...input.identity, version: 1, sessionID: id });
      sessions.set(id, session);
      return session;
    },
    publish: (session) => session, attachWorktree: () => {}, isBusy: (id) => busy.has(id),
    send: async (input) => {
      if (failure === 'send') throw new Error('send failed');
      sent.push({ id: input.id, text: input.text, context: (input.context ?? []).map((part) => part.text) });
      replies.set(input.id, 'Combined result');
      return 'message';
    },
  };
  const run = () => {
    const value = [...buildMultiRunIndex(sessions.values(), () => '/repo').runs.values()][0];
    if (!value) throw new Error('Empty premise: no run');
    return value;
  };
  const fuse = (sourceIds: string[], guidance?: string) => startRunFusion({
    run: run(), sourceIds, sessionById: sessions, judge: { providerID: 'provider', modelID: 'model', contextLimit: 100_000 }, guidance,
  }, io);
  return { sessions, refs, sent, busy, createdDirectories, projectPaths, conversations, fuse, fail: (kind: typeof failure) => { failure = kind; } };
}

describe('fusion workflow retention', () => {
  test('parent conversation guides later passes and cannot be a fusion source', async () => {
    const f = fixture(false);
    const parent = makeSession('parent', '/repo');
    parent.metadata = withMultiRunMembership({}, { version: 1, sessionID: parent.id, group, groupSlug: 'test', role: 'parent', providerID: 'provider', modelID: 'model' });
    f.sessions.set(parent.id, parent);
    f.conversations.set(parent.id, [{ role: 'user', text: 'Use the tests from A and the API from B.' }]);
    await f.fuse(['a', 'b']);
    expect(f.sent[0].context.join('\n')).toContain('Use the tests from A and the API from B.');
    await expect(f.fuse(['a', parent.id])).rejects.toThrow('membership changed');
    expect(f.sent).toHaveLength(1);
  });

  test('worktrees share resolved project ownership even when native project IDs differ', async () => {
    const f = fixture(true);
    const source = f.sessions.get('b');
    if (!source) throw new Error('Missing source premise');
    f.sessions.set('b', { ...source, projectID: 'another-location-id' });
    await f.fuse(['a', 'b']);
    expect(f.sent).toHaveLength(1);
    expect(f.refs.size).toBe(2);
  });

  test('different resolved projects are rejected even when native project IDs match', async () => {
    const f = fixture(true);
    f.projectPaths.set('b', '/other-project');
    await expect(f.fuse(['a', 'b'])).rejects.toThrow('different projects');
    expect(f.createdDirectories).toEqual([]);
    expect(f.refs.size).toBe(0);
  });
  // Oracle: every pass creates a new result, only snapshots source work, and
  // retains immutable receipts. The effects expose every operation the app uses.
  for (const code of [false, true]) {
    test(`repeat and combine ${code ? 'code' : 'answers'} without altering sources`, async () => {
      const f = fixture(code);
      const originalA = f.sessions.get('a');
      const originalB = f.sessions.get('b');
      const first = await f.fuse(['a', 'b'], 'Prefer the simpler API');
      const firstReceipt = getMultiRunIdentity(f.sessions.get(first.sessionId)!)?.fusion;
      const refsBefore = new Map(f.refs);
      const second = await f.fuse(['a', 'b']);
      const combined = await f.fuse([first.sessionId, second.sessionId]);
      expect(new Set([first.sessionId, second.sessionId, combined.sessionId]).size).toBe(3);
      expect(f.sessions.get('a')).toBe(originalA);
      expect(f.sessions.get('b')).toBe(originalB);
      expect(f.sessions.size).toBe(5);
      expect(firstReceipt?.sources.map((source) => source.sessionID)).toEqual(['a', 'b']);
      expect(getMultiRunIdentity(f.sessions.get(combined.sessionId)!)?.fusion?.sources.map((source) => source.sessionID)).toEqual([first.sessionId, second.sessionId]);
      expect(f.sent[0].context.join('\n')).toContain("Keep a's tests");
      expect(f.sent[0].context.join('\n')).toContain('Prefer the simpler API');
      expect(f.sent[2].context.join('\n')).toContain('Original task');
      for (const [ref, commit] of refsBefore) expect(f.refs.get(ref)).toBe(commit);
      if (code) {
        expect(f.refs.size).toBe(6);
        expect(new Set(f.createdDirectories).size).toBe(3);
        expect(firstReceipt?.sources.every((source) => source.snapshotRef && source.snapshotCommit)).toBe(true);
      } else expect(f.createdDirectories).toEqual([]);
    });
  }

  test('read or snapshot failure prevents result creation and preserves source sessions', async () => {
    for (const kind of ['reply', 'snapshot'] as const) {
      const f = fixture(true);
      const before = [...f.sessions];
      f.fail(kind);
      await expect(f.fuse(['a', 'b'])).rejects.toThrow('failed');
      expect([...f.sessions]).toEqual(before);
      expect(f.createdDirectories).toEqual([]);
      expect(f.sent).toEqual([]);
    }
  });

  test('send failure keeps source snapshots and the created result available for recovery', async () => {
    const f = fixture(true);
    f.fail('send');
    await expect(f.fuse(['a', 'b'])).rejects.toThrow('send failed');
    expect(f.sessions.size).toBe(3);
    expect(f.refs.size).toBe(2);
    expect(f.sessions.has('a') && f.sessions.has('b')).toBe(true);
  });

  test('running sources cannot be fused and duplicate sources are read once', async () => {
    const f = fixture(false);
    f.busy.add('a');
    await expect(f.fuse(['a', 'b'])).rejects.toThrow('still running');
    expect(f.sessions.size).toBe(2);
    f.busy.clear();
    await f.fuse(['a', 'a', 'b']);
    expect(f.sent[0].context.filter((part) => part.includes('--- RESULT '))).toHaveLength(2);
  });
});

// Manual integration oracle: real OpenCode records, filesystem contents and Git
// refs. Opt in only against profile:serve's synthetic, isolated project. This
// does not use a paid provider or commit anything in the application checkout.
const integrationUrl = process.env.MULTIRUN_TEST_URL;
const integrationRoot = process.env.MULTIRUN_TEST_ROOT;
if (!integrationUrl || !integrationRoot) console.info('Manual runtime retention check not configured; set MULTIRUN_TEST_URL and MULTIRUN_TEST_ROOT to run it.');
else test('isolated runtime retains source artifacts through repeated fusion and combination', async () => {
  if (!integrationUrl || !integrationRoot) throw new Error('Isolated runtime parameters missing');
  const { z } = await import('zod');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const url = new URL(integrationUrl);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Integration server must be loopback');
  const root = fs.realpathSync(integrationRoot);
  const settings = z.object({ projects: z.array(z.object({ path: z.string() })) }).parse(await fetch(new URL('/api/config/settings', url)).then((response) => response.json()));
  if (!settings.projects.some((project) => path.resolve(project.path) === path.join(root, 'project'))) throw new Error('Server is not the isolated fixture');
  const repo = fs.mkdtempSync(path.join(root, 'integration-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env: {
    PATH: process.env.PATH, HOME: path.join(root, 'state/home'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  }, encoding: 'utf8' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'Fixture base\n');
  git(['add', 'base.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture base']);
  const { configureRuntimeUrlResolver } = await import('@/lib/runtime-url');
  const { initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');
  configureRuntimeUrlResolver({ apiBaseUrl: url.origin });
  initializeRuntimeEndpoint({ apiBaseUrl: url.origin });
  const { opencodeClient } = await import('@/lib/opencode/client');
  opencodeClient.reconnectToRuntimeBaseUrl();
  opencodeClient.setDirectory(repo);
  const { ChildStoreManager } = await import('@/sync/child-store');
  const { setSyncRefs } = await import('@/sync/sync-refs');
  const manager = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), manager, repo);
  const { setActionRefs, setOptimisticRefs } = await import('@/sync/session-actions');
  setActionRefs(manager, () => repo);
  // This integration checks authoritative records, not optimistic UI paint.
  setOptimisticRefs(() => {}, () => {});
  const { useConfigStore } = await import('@/stores/useConfigStore');
  if (!await useConfigStore.getState().probeConnection({ timeoutMs: 10_000 })) throw new Error('Isolated OpenCode connection failed');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useMultiRunStore, registerMultiRunSession } = await import('@/stores/useMultiRunStore');
  const { routeMessage } = await import('@/sync/session-ui-store');
  const { useGlobalSessionStatusStore } = await import('@/sync/global-session-status');
  const { attachSessionToRun, detachSessionFromRun, saveFusionGuidance } = await import('./membership');
  const { createRunParent } = await import('./parent');
  const { loadLaneLastReply } = await import('./laneData');
  const { getGitRangeDiff } = await import('@/lib/gitApi');
  useProjectsStore.setState({ projects: [{ id: 'fixture', path: repo }], activeProjectId: 'fixture' });
  try {
    const catalog = await opencodeClient.getProvidersForConfig(repo, { fresh: true });
    if (!catalog.models.some((model) => model.providerID === 'perf' && model.id === 'think-30s')) throw new Error('Synthetic provider is unavailable');
    const created = await useMultiRunStore.getState().createMultiRun({ name: 'retention-check', isolateRuns: true, worktreeBaseBranch: 'HEAD', groups: [{
      prompt: 'Synthetic retention check', models: [{ providerID: 'perf', modelID: 'think-30s' }, { providerID: 'perf', modelID: 'think-30s' }],
    }] });
    if (!created || created.sessionIds.length !== 2) throw new Error(`Source creation failed: ${useMultiRunStore.getState().error}`);
    const ids = [...created.sessionIds];
    const sessions = new Map<string, Session>();
    const refresh = async () => {
      for (const id of ids) sessions.set(id, await opencodeClient.getSession(id));
      const run = [...buildMultiRunIndex(sessions.values(), () => repo).runs.values()][0];
      if (!run) throw new Error('The run disappeared');
      return run;
    };
    let run = await refresh();
    const sources = created.sessionIds.map((id) => {
      const session = sessions.get(id);
      if (!session || !session.directory.startsWith(root + path.sep)) throw new Error('Source left isolated fixture');
      return session;
    });
    expect(new Set(sources.map((session) => session.directory)).size).toBe(2);
    const runningDeadline = Date.now() + 20_000;
    let active = new Set<string>();
    while (Date.now() < runningDeadline) {
      const statuses = await opencodeClient.getActiveSessionStatuses();
      if (!statuses) throw new Error('Live status failed');
      active = new Set(Object.keys(statuses).filter((id) => statuses[id].type !== 'idle'));
      if (sources.every((session) => active.has(session.id))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(sources.every((session) => active.has(session.id))).toBe(true);
    useGlobalSessionStatusStore.setState({ activeSessionIds: active });
    for (const [index, source] of sources.entries()) {
      fs.writeFileSync(path.join(source.directory, '.gitignore'), 'ignored-artifact.txt\n');
      fs.writeFileSync(path.join(source.directory, 'result.txt'), `Result ${index} original\n`);
      fs.writeFileSync(path.join(source.directory, 'ignored-artifact.txt'), `Ignored result ${index}\n`);
    }
    expect(await detachSessionFromRun({ session: sources[0], runKey: run.key, confirmed: false })).toBe(false);
    expect(getMultiRunIdentity(await opencodeClient.getSession(sources[0].id))?.key).toBe(run.key);
    const parent = await createRunParent({ run, sessionById: sessions, model: { providerID: 'perf', modelID: 'stream-20000cps' }, title: 'Fixture parent' });
    ids.push(parent.id);
    await routeMessage({ sessionId: parent.id, directory: parent.directory, content: 'Ask about progress. Preserve both source results for later fusion.', providerID: 'perf', modelID: 'stream-20000cps' });
    await opencodeClient.getSdkClient().session.wait({ sessionID: parent.id });
    expect(await loadLaneLastReply(parent.id, parent.directory)).toBeTruthy();
    const parentMessages = await opencodeClient.getSessionMessages(parent.id, { limit: 50 }, parent.directory);
    // OpenCode stores synthetic context on the message, separately from parts.
    const parentContext = parentMessages.items.flatMap((record) => record.info.role === 'synthetic' ? [record.info.text] : []).join('\n');
    expect(parentContext).toContain('"status":"working"');
    expect(parentContext).toContain(sources[0].id);
    expect(parentContext).toContain(sources[1].id);
    for (const source of sources) await opencodeClient.getSdkClient().session.wait({ sessionID: source.id });
    useGlobalSessionStatusStore.setState({ activeSessionIds: new Set() });
    run = await refresh();
    await saveFusionGuidance({ session: sources[0], runKey: run.key, guidance: 'Keep the source result files and ignored artifacts.' });
    const fuse = async (sourceIds: string[]) => {
      const current = await refresh();
      const result = await startRunFusion({ run: current, sourceIds, sessionById: sessions, judge: { providerID: 'perf', modelID: 'stream-20000cps', contextLimit: 32_000 } });
      ids.push(result.sessionId);
      await opencodeClient.getSdkClient().session.wait({ sessionID: result.sessionId });
      return await opencodeClient.getSession(result.sessionId);
    };
    const first = await fuse(created.sessionIds);
    const firstMessages = await opencodeClient.getSessionMessages(first.id, { limit: 50 }, first.directory);
    const firstContext = firstMessages.items.flatMap((record) => record.info.role === 'synthetic' ? [record.info.text] : []).join('\n');
    expect(firstContext).toContain('Preserve both source results for later fusion.');
    expect(firstContext).toContain('Keep the source result files and ignored artifacts.');
    const receipt = getMultiRunIdentity(first)?.fusion;
    const sourceRef = receipt?.sources[0].snapshotRef;
    if (!sourceRef || !receipt?.baseCommit) throw new Error('Snapshot receipt missing');
    fs.writeFileSync(path.join(first.directory, 'fused-result.txt'), 'Committed fusion artifact\n');
    git(['-C', first.directory, 'add', 'fused-result.txt']);
    git(['-C', first.directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture fusion artifact']);
    fs.writeFileSync(path.join(sources[0].directory, 'result.txt'), 'Result 0 revised\n');
    const second = await fuse(created.sessionIds);
    const combined = await fuse([first.id, second.id]);
    expect(new Set([first.directory, second.directory, combined.directory]).size).toBe(3);
    expect(combined.directory).not.toBe(repo);
    expect(getMultiRunIdentity(combined)?.fusion?.baseCommit).toBe(receipt.baseCommit);
    const combinedSource = getMultiRunIdentity(combined)?.fusion?.sources[0];
    if (!combinedSource?.snapshotCommit) throw new Error('Combined code snapshot missing');
    const combinedInput = await getGitRangeDiff(repo, { base: receipt.baseCommit, head: combinedSource.snapshotCommit });
    expect(combinedInput.diff).toContain('Committed fusion artifact');
    expect(fs.readFileSync(path.join(first.directory, 'fused-result.txt'), 'utf8')).toBe('Committed fusion artifact\n');
    const retained = await getGitRangeDiff(repo, { base: receipt.baseCommit, head: sourceRef });
    expect(retained.diff).toContain('Result 0 original');
    expect(retained.diff).not.toContain('Result 0 revised');
    for (const [index, source] of sources.entries()) {
      expect(fs.readFileSync(path.join(source.directory, 'ignored-artifact.txt'), 'utf8')).toBe(`Ignored result ${index}\n`);
      expect(fs.existsSync(path.join(source.directory, 'result.txt'))).toBe(true);
      expect((await opencodeClient.getSession(source.id)).time.archived).toBeUndefined();
    }
    const existing = await opencodeClient.createSession({ title: 'Existing fixture result', model: { providerID: 'perf', id: 'stream-20000cps' } }, repo);
    registerMultiRunSession(existing, existing.directory);
    fs.writeFileSync(path.join(existing.directory, 'imported-result.txt'), 'Existing retained result\n');
    await opencodeClient.sendMessage({ id: existing.id, directory: existing.directory, providerID: 'perf', text: 'Existing synthetic result' });
    await opencodeClient.getSdkClient().session.wait({ sessionID: existing.id });
    run = await refresh();
    const attached = await attachSessionToRun({ run, session: existing, anchor: sources[1] });
    expect(getMultiRunIdentity(attached)?.key).toBe(run.key);
    const viewed = await opencodeClient.getSession(attached.id);
    if (!viewed.time.idle) throw new Error('The existing session did not finish');
    await opencodeClient.getSdkClient().session.view({ sessionID: attached.id, idle: viewed.time.idle });
    expect(getMultiRunIdentity(await opencodeClient.getSession(attached.id))?.key).toBe(run.key);
    await detachSessionFromRun({ session: attached, runKey: run.key, confirmed: true });
    expect(getMultiRunIdentity(await opencodeClient.getSession(attached.id))).toBeNull();
    expect(fs.readFileSync(path.join(existing.directory, 'imported-result.txt'), 'utf8')).toBe('Existing retained result\n');
  } finally { manager.disposeAll(); }
}, 120_000);
