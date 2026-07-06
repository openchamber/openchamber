import { describe, it, expect, vi } from 'vitest';
import { parseLeadingCommand, executeMessengerCommand } from './messenger-commands.js';

const ctx = { type: 'discord', token: 't', channelId: 'c1', threadId: null };

function makeMutators() {
  return {
    setOverrides: vi.fn(async () => {}),
    setVerbosityDefault: vi.fn(async () => {}),
    setPermissionModeDefault: vi.fn(async () => {}),
    setProjectDefaults: vi.fn(async () => {}),
    unbindSession: vi.fn(async () => {}),
  };
}

async function run(text, { binding = null, surfaceMutators = makeMutators(), opencode = {}, bridgeOps = null } = {}) {
  const command = parseLeadingCommand(text);
  const result = await executeMessengerCommand({
    command,
    ctx,
    opencode,
    binding,
    surfaceMutators,
    bridgeOps,
  });
  return { result, surfaceMutators };
}

describe('parseLeadingCommand', () => {
  it('extracts /verbosity with args', () => {
    expect(parseLeadingCommand('/verbosity verbose')).toMatchObject({
      name: 'verbosity',
      args: 'verbose',
    });
  });
  it('returns null for plain prompts', () => {
    expect(parseLeadingCommand('just a message')).toBeNull();
  });
  it('ignores a leading ! by default', () => {
    expect(parseLeadingCommand('!status')).toBeNull();
  });
  it('accepts a leading ! as a / alias when allowBang is set', () => {
    expect(parseLeadingCommand('!status', { allowBang: true })).toMatchObject({
      name: 'status',
      args: '',
    });
  });
  it('parses ! command args and body when allowBang is set', () => {
    expect(parseLeadingCommand('!model anthropic/claude\nextra', { allowBang: true })).toMatchObject({
      name: 'model',
      args: 'anthropic/claude',
      body: 'extra',
    });
  });
  it('still parses / commands when allowBang is set', () => {
    expect(parseLeadingCommand('/verbosity verbose', { allowBang: true })).toMatchObject({
      name: 'verbosity',
      args: 'verbose',
    });
  });
});

describe('/verbosity command', () => {
  it('lists levels and marks the effective one when called with no args', async () => {
    const { result, surfaceMutators } = await run('/verbosity', {
      binding: { verbosityDefault: 'verbose' },
    });
    expect(result.reply).toContain('Output verbosity');
    expect(result.reply).toContain('quiet');
    expect(result.reply).toContain('verbose');
    // effective marker (➤) appears on the default level
    expect(result.reply).toContain('➤ `verbose`');
    expect(surfaceMutators.setOverrides).not.toHaveBeenCalled();
  });

  it('sets a per-conversation override', async () => {
    const { result, surfaceMutators } = await run('/verbosity verbose');
    expect(surfaceMutators.setOverrides).toHaveBeenCalledWith({ verbosityOverride: 'verbose' });
    expect(result.reply).toMatch(/Verbosity set to `verbose`/);
  });

  it('accepts aliases (high -> verbose, low -> quiet)', async () => {
    const a = await run('/verbosity high');
    expect(a.surfaceMutators.setOverrides).toHaveBeenCalledWith({ verbosityOverride: 'verbose' });
    const b = await run('/verbosity low');
    expect(b.surfaceMutators.setOverrides).toHaveBeenCalledWith({ verbosityOverride: 'quiet' });
  });

  it('sets the messenger-wide default with `default <level>`', async () => {
    const { surfaceMutators } = await run('/verbosity default quiet');
    expect(surfaceMutators.setVerbosityDefault).toHaveBeenCalledWith('quiet');
  });

  it('clears the conversation override with reset', async () => {
    const { surfaceMutators } = await run('/verbosity reset');
    expect(surfaceMutators.setOverrides).toHaveBeenCalledWith({ verbosityOverride: null });
  });

  it('clears the default with `default reset`', async () => {
    const { surfaceMutators } = await run('/verbosity default reset');
    expect(surfaceMutators.setVerbosityDefault).toHaveBeenCalledWith(null);
  });

  it('rejects unknown levels without mutating', async () => {
    const { result, surfaceMutators } = await run('/verbosity loud');
    expect(result.reply).toMatch(/Unknown level/);
    expect(surfaceMutators.setOverrides).not.toHaveBeenCalled();
  });
});

describe('/model + /status surface the OpenChamber default model', () => {
  const opencode = { listProviders: async () => [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4' }] }] };

  it('/model with no args shows the OpenChamber default when no override is set', async () => {
    const { result } = await run('/model', {
      opencode,
      binding: {
        globalDefaultModel: 'anthropic/claude-sonnet-4',
        projectDefaults: null,
      },
    });
    expect(result.reply).toContain('OpenChamber default');
    expect(result.reply).toContain('anthropic/claude-sonnet-4');
  });

  it('/model with no args explains nothing is set when there is no default anywhere', async () => {
    const { result } = await run('/model', { opencode, binding: {} });
    expect(result.reply).toMatch(/No default set/);
  });

  it('/status falls back to the OpenChamber default model + agent', async () => {
    const { result } = await run('/status', {
      binding: {
        globalDefaultModel: 'openai/gpt-5',
        globalDefaultAgent: 'build',
      },
    });
    expect(result.reply).toContain('`openai/gpt-5` _(OpenChamber default)_');
    expect(result.reply).toContain('`build` _(OpenChamber default)_');
  });

  it('/status prefers a surface override over the OpenChamber default', async () => {
    const { result } = await run('/status', {
      binding: { modelOverride: 'x/y', globalDefaultModel: 'openai/gpt-5' },
    });
    expect(result.reply).toContain('`x/y` _(this conversation)_');
    expect(result.reply).not.toContain('OpenChamber default');
  });
});

describe('/help includes verbosity and skill', () => {
  it('lists the /verbosity, /skill and /yolo commands', async () => {
    const { result } = await run('/help');
    expect(result.reply).toContain('/verbosity');
    expect(result.reply).toContain('/skill');
    expect(result.reply).toContain('/yolo');
  });
});

describe('/yolo (permission mode) command', () => {
  it('lists the modes and marks the effective one with no args', async () => {
    const { result, surfaceMutators } = await run('/yolo', {
      binding: { permissionModeDefault: 'auto-edit' },
    });
    expect(result.reply).toContain('Tool permission mode');
    expect(result.reply).toContain('yolo');
    expect(result.reply).toContain('➤ `auto-edit`');
    expect(surfaceMutators.setOverrides).not.toHaveBeenCalled();
  });

  it('sets a conversation override', async () => {
    const { surfaceMutators } = await run('/yolo yolo');
    expect(surfaceMutators.setOverrides).toHaveBeenCalledWith({ permissionModeOverride: 'yolo' });
  });

  it('accepts aliases', async () => {
    const a = await run('/yolo safe');
    expect(a.surfaceMutators.setOverrides).toHaveBeenCalledWith({ permissionModeOverride: 'auto-edit' });
    const b = await run('/yolo on');
    expect(b.surfaceMutators.setOverrides).toHaveBeenCalledWith({ permissionModeOverride: 'yolo' });
  });

  it('sets the messenger default via `default`', async () => {
    const { surfaceMutators } = await run('/yolo default yolo');
    expect(surfaceMutators.setPermissionModeDefault).toHaveBeenCalledWith('yolo');
  });

  it('sets a project default via `project` when bound', async () => {
    const { surfaceMutators } = await run('/yolo project yolo', {
      binding: { projectPath: '/proj', projectLabel: 'Proj' },
    });
    expect(surfaceMutators.setProjectDefaults).toHaveBeenCalledWith({ permissionModeDefault: 'yolo' });
  });

  it('clears the conversation override via reset', async () => {
    const { surfaceMutators } = await run('/yolo reset');
    expect(surfaceMutators.setOverrides).toHaveBeenCalledWith({ permissionModeOverride: null });
  });

  it('rejects unknown modes without mutating', async () => {
    const { result, surfaceMutators } = await run('/yolo maybe');
    expect(result.reply).toMatch(/Unknown mode/);
    expect(surfaceMutators.setOverrides).not.toHaveBeenCalled();
  });
});

describe('/skill command', () => {
  const opencode = {
    listSkills: async () => [
      { name: 'theme-system', description: 'theme tokens' },
      { name: 'drag-to-reorder', description: 'dnd-kit lists' },
    ],
    sendPrompt: vi.fn(async () => ({ ok: true })),
  };

  it('lists available skills with no args', async () => {
    const { result } = await run('/skill', { opencode, binding: { projectPath: '/p' } });
    expect(result.reply).toContain('Available skills');
    expect(result.reply).toContain('theme-system');
    expect(result.reply).toContain('drag-to-reorder');
  });

  it('hands a named skill to the agent when a session exists', async () => {
    const sendPrompt = vi.fn(async () => ({ ok: true }));
    const { result } = await run('/skill theme-system', {
      opencode: { ...opencode, sendPrompt },
      binding: { sessionId: 'ses-1', projectPath: '/p' },
    });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][2]).toContain('theme-system');
    expect(result.reply).toMatch(/Handed the `theme-system` skill/);
  });

  it('rejects an unknown skill name', async () => {
    const { result } = await run('/skill nope', { opencode, binding: { sessionId: 'ses-1' } });
    expect(result.reply).toMatch(/Unknown skill/);
  });

  it('asks for a message first when no session is bound', async () => {
    const { result } = await run('/skill theme-system', { opencode, binding: { sessionId: null } });
    expect(result.reply).toMatch(/Send a regular message first/);
  });
});

describe('/abort and /model still resolve as known commands', () => {
  it('abort without a session replies with a friendly error (not pass-through)', async () => {
    const { result } = await run('/abort', { binding: { sessionId: null } });
    expect(result).not.toBeNull();
    expect(result.reply).toMatch(/No session/);
  });
  it('unknown commands pass through (null) for OpenCode to handle', async () => {
    const { result } = await run('/changelog');
    expect(result).toBeNull();
  });
});

describe('/abort clears the queue', () => {
  it('reports cleared queued messages on a successful abort', async () => {
    const clearQueue = vi.fn(async () => 2);
    const { result } = await run('/abort', {
      binding: { sessionId: 'ses-1' },
      opencode: { abortSession: async () => ({ ok: true }) },
      bridgeOps: { clearQueue },
    });
    expect(clearQueue).toHaveBeenCalled();
    expect(result.reply).toContain('Cleared 2 queued messages');
  });
});

describe('/share and /unshare', () => {
  it('returns the public URL on success', async () => {
    const { result } = await run('/share', {
      binding: { sessionId: 'ses-1', projectPath: '/p' },
      opencode: { shareSession: async () => ({ ok: true, url: 'https://opencode.ai/share/abc' }) },
    });
    expect(result.reply).toContain('https://opencode.ai/share/abc');
  });
  it('requires an active session', async () => {
    const { result } = await run('/share', { binding: { sessionId: null } });
    expect(result.reply).toMatch(/No session/);
  });
  it('unshare revokes the link', async () => {
    const { result } = await run('/unshare', {
      binding: { sessionId: 'ses-1' },
      opencode: { unshareSession: async () => ({ ok: true }) },
    });
    expect(result.reply).toMatch(/revoked/);
  });
});

describe('/queue and /clear-queue', () => {
  it('queues when a response is running', async () => {
    const queueMessage = vi.fn(async () => ({ ok: true, queued: true, position: 1 }));
    const { result } = await run('/queue Now add tests', {
      binding: { sessionId: 'ses-1' },
      bridgeOps: { queueMessage },
    });
    expect(queueMessage).toHaveBeenCalledWith({ text: 'Now add tests' });
    expect(result.reply).toContain('queued (position: 1)');
  });
  it('sends immediately when idle', async () => {
    const queueMessage = vi.fn(async () => ({ ok: true, queued: false }));
    const { result } = await run('/queue do it', { bridgeOps: { queueMessage } });
    expect(result.reply).toMatch(/Sent immediately/);
  });
  it('requires a message argument', async () => {
    const { result } = await run('/queue', { bridgeOps: { queueMessage: vi.fn() } });
    expect(result.reply).toMatch(/Usage/);
  });
  it('clear-queue reports the number of cleared messages', async () => {
    const { result } = await run('/clear-queue', { bridgeOps: { clearQueue: async () => 3 } });
    expect(result.reply).toContain('Cleared 3 queued messages');
  });
  it('clear-queue handles an empty queue', async () => {
    const { result } = await run('/clear-queue', { bridgeOps: { clearQueue: async () => 0 } });
    expect(result.reply).toMatch(/already empty/);
  });
});

describe('/mention-mode', () => {
  it('toggles on and explains the behaviour', async () => {
    const { result } = await run('/mention-mode', {
      bridgeOps: { toggleMentionMode: async () => true },
    });
    expect(result.reply).toContain('**enabled**');
  });
  it('toggles off', async () => {
    const { result } = await run('/mention-mode', {
      bridgeOps: { toggleMentionMode: async () => false },
    });
    expect(result.reply).toContain('**disabled**');
  });
});

describe('/session', () => {
  it('starts a session with the given prompt', async () => {
    const startSession = vi.fn(async () => ({ ok: true, threadId: 'th-9' }));
    const { result } = await run('/session Add user authentication', {
      bridgeOps: { startSession },
    });
    expect(startSession).toHaveBeenCalledWith({ prompt: 'Add user authentication' });
    expect(result.reply).toContain('Starting OpenCode session');
    expect(result.reply).toContain('<#th-9>');
  });
  it('requires a prompt', async () => {
    const { result } = await run('/session', { bridgeOps: { startSession: vi.fn() } });
    expect(result.reply).toMatch(/Usage/);
  });
});

describe('/resume', () => {
  it('lists candidates with no args', async () => {
    const { result } = await run('/resume', {
      bridgeOps: {
        resumeSession: vi.fn(),
        listResumeCandidates: async () => [
          { id: 'ses-a', title: 'Fix login', when: 'today' },
        ],
      },
    });
    expect(result.reply).toContain('Resume a session');
    expect(result.reply).toContain('Fix login');
    expect(result.reply).toContain('ses-a');
  });
  it('resumes by reference', async () => {
    const resumeSession = vi.fn(async () => ({ ok: true, threadId: 'th-1', title: 'Fix login', loadedNote: 'Loaded 4 messages.' }));
    const { result } = await run('/resume 1', {
      bridgeOps: { resumeSession, listResumeCandidates: vi.fn() },
    });
    expect(resumeSession).toHaveBeenCalledWith({ ref: '1' });
    expect(result.reply).toContain('Session resumed');
    expect(result.reply).toContain('<#th-1>');
  });
});

describe('/fork', () => {
  const binding = { sessionId: 'ses-1', projectPath: '/p' };
  it('requires a session', async () => {
    const { result } = await run('/fork', { bridgeOps: { forkSession: vi.fn(), listForkCandidates: vi.fn() } });
    expect(result.reply).toMatch(/No session/);
  });
  it('lists user messages with no args', async () => {
    const { result } = await run('/fork', {
      binding,
      bridgeOps: {
        forkSession: vi.fn(),
        listForkCandidates: async () => [{ preview: 'Add auth', when: 'now' }],
      },
    });
    expect(result.reply).toContain('Fork this session');
    expect(result.reply).toContain('Add auth');
  });
  it('forks from the selected message', async () => {
    const forkSession = vi.fn(async () => ({ ok: true, threadId: 'th-2' }));
    const { result } = await run('/fork 2', {
      binding,
      bridgeOps: { forkSession, listForkCandidates: vi.fn() },
    });
    expect(forkSession).toHaveBeenCalledWith({ index: 2 });
    expect(result.reply).toContain('Session forked');
  });
  it('rejects a non-numeric pick', async () => {
    const { result } = await run('/fork abc', {
      binding,
      bridgeOps: { forkSession: vi.fn(), listForkCandidates: vi.fn() },
    });
    expect(result.reply).toMatch(/Usage/);
  });
});

describe('worktree commands', () => {
  it('new-worktree reports the created worktree + thread', async () => {
    const newWorktree = vi.fn(async () => ({ ok: true, path: '/wt/feature', branch: 'feature', threadId: 'th-3' }));
    const { result } = await run('/new-worktree feature', {
      binding: { projectPath: '/p' },
      bridgeOps: { newWorktree },
    });
    expect(newWorktree).toHaveBeenCalledWith({ name: 'feature' });
    expect(result.reply).toContain('🌳 Worktree');
    expect(result.reply).toContain('/wt/feature');
  });
  it('new-worktree requires a bound project', async () => {
    const { result } = await run('/new-worktree feature', {
      binding: { projectPath: null },
      bridgeOps: { newWorktree: vi.fn() },
    });
    expect(result.reply).toMatch(/not bound to a project/);
  });
  it('merge-worktree reports a successful merge', async () => {
    const { result } = await run('/merge-worktree', {
      binding: { projectPath: '/wt/feature' },
      bridgeOps: { mergeWorktree: async () => ({ ok: true, summary: 'Merged `feature` into `main` @ abc123 (2 commits squashed).' }) },
    });
    expect(result.reply).toContain('Merged `feature` into `main`');
  });
  it('merge-worktree surfaces conflicts with guidance', async () => {
    const { result } = await run('/merge-worktree', {
      binding: { projectPath: '/wt/feature' },
      bridgeOps: { mergeWorktree: async () => ({ ok: false, conflict: true, error: 'rebase conflicts', promptSent: true }) },
    });
    expect(result.reply).toContain('Merge conflict detected');
    expect(result.reply).toContain('asked the model');
  });
  it('list-worktrees renders project worktrees', async () => {
    const { result } = await run('/list-worktrees', {
      binding: { projectPath: '/repo' },
      bridgeOps: {
        listWorktrees: async () => ({
          ok: true,
          worktrees: [{ branch: 'feature', path: '/repo/wt/feature', status: { ahead: 1, isDirty: true }, threadId: 'th-1' }],
        }),
      },
    });
    expect(result.reply).toContain('feature');
    expect(result.reply).toContain('<#th-1>');
  });
  it('open-worktree requires a query', async () => {
    const { result } = await run('/open-worktree', {
      binding: { projectPath: '/repo' },
      bridgeOps: { openWorktree: vi.fn() },
    });
    expect(result.reply).toMatch(/Usage/);
  });
  it('worktree-status reports git state', async () => {
    const { result } = await run('/worktree-status', {
      binding: { projectPath: '/repo/wt/feature', branch: 'feature' },
      bridgeOps: {
        worktreeStatus: async () => ({
          ok: true,
          path: '/repo/wt/feature',
          projectRoot: '/repo',
          isWorktree: true,
          branch: 'feature',
          status: { ahead: 2, behind: 0, isDirty: false },
          threadId: 'th-9',
        }),
      },
    });
    expect(result.reply).toContain('feature');
    expect(result.reply).toContain('<#th-9>');
  });
});

describe('/shell command', () => {
  const binding = { sessionId: 'ses-1', projectPath: '/p' };

  it('runs the command through bridgeOps.runShell and acks immediately', async () => {
    const runShell = vi.fn(async () => ({ ok: true }));
    const { result } = await run('/shell pwd', { binding, bridgeOps: { runShell } });
    expect(runShell).toHaveBeenCalledWith({ command: 'pwd' });
    expect(result.reply).toContain('Running');
    expect(result.reply).toContain('pwd');
  });

  it('passes multi-line bodies through to the shell', async () => {
    const runShell = vi.fn(async () => ({ ok: true }));
    await run('/shell cd /tmp\nls -la', { binding, bridgeOps: { runShell } });
    expect(runShell).toHaveBeenCalledWith({ command: 'cd /tmp\nls -la' });
  });

  it('requires an argument', async () => {
    const { result } = await run('/shell', { binding, bridgeOps: { runShell: vi.fn() } });
    expect(result.reply).toMatch(/Usage/);
  });

  it('works without an active session (runShell auto-creates one)', async () => {
    const runShell = vi.fn(async () => ({ ok: true }));
    const { result } = await run('/shell pwd', { binding: { projectPath: '/p' }, bridgeOps: { runShell } });
    expect(runShell).toHaveBeenCalledWith({ command: 'pwd' });
    expect(result.reply).toContain('Running');
  });

  it('surfaces shell failures', async () => {
    const { result } = await run('/shell pwd', {
      binding,
      bridgeOps: { runShell: async () => ({ ok: false, error: 'OpenCode 404: not found' }) },
    });
    expect(result.reply).toContain('Shell command failed');
    expect(result.reply).toContain('404');
  });

  it('is reachable via the ! alias on Discord', async () => {
    const runShell = vi.fn(async () => ({ ok: true }));
    const command = parseLeadingCommand('!shell pwd', { allowBang: true });
    const result = await executeMessengerCommand({
      command,
      ctx,
      opencode: {},
      binding,
      surfaceMutators: makeMutators(),
      bridgeOps: { runShell },
    });
    expect(runShell).toHaveBeenCalledWith({ command: 'pwd' });
    expect(result.reply).toContain('Running');
  });
});

describe('/help lists the extended command set', () => {
  it('mentions queue, fork, share, resume, worktrees and mention-mode', async () => {
    const { result } = await run('/help');
    for (const cmd of [
      '/queue',
      '/fork',
      '/share',
      '/resume',
      '/new-worktree',
      '/merge-worktree',
      '/list-worktrees',
      '/open-worktree',
      '/worktree-status',
      '/mention-mode',
      '/clear-queue',
      '/session',
      '/shell',
    ]) {
      expect(result.reply).toContain(cmd);
    }
  });
});
