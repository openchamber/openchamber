import crypto from 'node:crypto';
import { asNonEmptyString } from '../shared/guards.js';
import { getCheckedOutBranch, isLinkedWorktree } from '../git/service.js';
import { OpenChamberControlError } from './error.js';
import { actionPlatformOf, isActionForPlatform } from '../projects/project-setup.js';
import { probeUrl as fetchProbe, waitForRun } from './action-readiness.js';
import type { ProbeUrl, RunReadiness } from './action-readiness.js';
import type { createTerminalRuntime, TerminalListing } from '../terminal/runtime.js';
import type { ProjectAction } from '../projects/contracts.js';
import type { ControlInput } from './contracts.js';

type TerminalRuntime = Pick<ReturnType<typeof createTerminalRuntime>, 'listTerminals' | 'readTerminal' | 'createSession' | 'closeTerminal'>;

interface ProjectActionsSettings {
  agentActionsToolEnabled?: unknown;
  terminalShell?: unknown;
  terminalLoginShells?: unknown;
  projects?: unknown;
}

interface MergedSetup {
  projectActions: (ProjectAction & { source?: 'shared' | 'personal' })[];
  trust: { trusted: boolean };
}

interface OpenUrlCheckout {
  branch: string | null;
  linkedWorktree: boolean;
}

export interface ProjectActionsDependencies {
  readSettings: () => Promise<ProjectActionsSettings | null>;
  getTerminalRuntime: () => TerminalRuntime | null;
  projectPathFor: (directory: string) => Promise<string>;
  readProjectSetup: (projectId: string) => Promise<MergedSetup>;
  readCheckout?: (directory: string) => Promise<OpenUrlCheckout>;
  platform?: NodeJS.Platform;
  probeUrl?: ProbeUrl;
  readyWait?: { limitMs: number; pollMs: number };
}

const READY_WAIT = { limitMs: 120_000, pollMs: 1_000 };
const OUTPUT_TAIL_BYTES = 4_096;

type StartedBy = 'you' | 'the user' | 'another session';

const SPACE_DIRECTORY = /^\/spaces\/[0-9a-f]{12}(?:\/|$)/;
const OPEN_URL_TEMPLATE = /\{(worktree|branch)\}/g;
const DEFAULT_BRANCHES = new Set(['main', 'master']);
const UNTRUSTED_NOTE = "This shared action comes from the repository's .openchamber/project.json, which the user has not trusted on this computer yet."
  + ' The user trusts it once by running one of these actions from the actions menu; until then it cannot run from here.';

const isProjectList = (value: unknown): value is { id?: unknown; path?: unknown }[] => Array.isArray(value);

const readGitCheckout = async (directory: string): Promise<OpenUrlCheckout> => ({
  branch: await getCheckedOutBranch(directory),
  linkedWorktree: await isLinkedWorktree(directory),
});

const isControlCharacter = (character: string) => {
  const code = character.charCodeAt(0);
  return code === 127 || (code < 32 && code !== 9 && code !== 10);
};

const normalizeCommand = (command: string) => [...command.trim().replace(/\r\n|\r/g, '\n')]
  .filter((character) => !isControlCharacter(character))
  .join('');

const hostnameLabel = (name: string) => {
  const label = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (label.length <= 63) return label;
  const hash = crypto.createHash('sha256').update(label).digest('hex').slice(0, 6);
  return `${label.slice(0, 56).replace(/-+$/, '')}-${hash}`;
};

const tidyHost = (authority: string) => {
  const at = authority.lastIndexOf('@');
  const userInfo = at >= 0 ? authority.slice(0, at + 1) : '';
  const hostPort = authority.slice(at + 1);
  if (hostPort.startsWith('[')) return authority;
  const colon = hostPort.lastIndexOf(':');
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon >= 0 ? hostPort.slice(colon) : '';
  return `${userInfo}${host.split('.').map((label) => label.replace(/^-+|-+$/g, '')).filter(Boolean).join('.')}${port}`;
};

export const fillOpenUrlTemplate = (template: string, { branch, linkedWorktree }: OpenUrlCheckout) => {
  const values = {
    worktree: linkedWorktree && branch && !DEFAULT_BRANCHES.has(branch) ? hostnameLabel(branch.split('/').pop() ?? '') : '',
    branch: branch ? hostnameLabel(branch) : '',
  };
  const filled = template.replace(OPEN_URL_TEMPLATE, (_match, name: 'worktree' | 'branch') => values[name]);
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(filled);
  if (!parts) return filled;
  const [, scheme = '', authority = '', rest = ''] = parts;
  return `${scheme}${tidyHost(authority)}${rest}`;
};

const startedByOf = (purpose: TerminalListing['purpose'], sessionId: string | null): StartedBy => {
  const agentSessionId = purpose.type === 'project-action' ? purpose.agentSessionId : undefined;
  if (!agentSessionId) return 'the user';
  return agentSessionId === sessionId ? 'you' : 'another session';
};

export const createProjectActionsTool = ({
  readSettings,
  getTerminalRuntime,
  projectPathFor,
  readProjectSetup,
  readCheckout = readGitCheckout,
  platform = process.platform,
  probeUrl = fetchProbe,
  readyWait = READY_WAIT,
}: ProjectActionsDependencies) => {
  const currentPlatform = actionPlatformOf(platform);

  const readActions = async (directory: string, settings: ProjectActionsSettings) => {
    const projectPath = await projectPathFor(directory);
    const project = (isProjectList(settings.projects) ? settings.projects : []).find((entry) => entry.path === projectPath);
    const projectId = asNonEmptyString(project?.id);
    if (!projectId) return null;
    const setup = await readProjectSetup(projectId);
    return setup.projectActions.filter((action) => isActionForPlatform(action, currentPlatform)).map((action) => ({
      action,
      directory: action.runIn === 'parent' ? projectPath : directory,
      needsTrust: action.source === 'shared' && !setup.trust.trusted,
    }));
  };

  const readEnabledSettings = async () => {
    const settings = await readSettings().catch(() => null);
    return settings?.agentActionsToolEnabled === true ? settings : null;
  };

  const hasActions = async (directory: string) => {
    const settings = directory && !SPACE_DIRECTORY.test(directory) ? await readEnabledSettings() : null;
    const actions = settings ? await readActions(directory, settings).catch(() => null) : null;
    return Boolean(actions?.length);
  };

  const urlOf = async (action: ProjectAction, directory: string): Promise<{ url?: string }> => {
    if (!action.openUrl) return {};
    if (!/\{(worktree|branch)\}/.test(action.openUrl)) return { url: action.openUrl };
    const checkout = await readCheckout(directory).catch(() => null);
    return checkout ? { url: fillOpenUrlTemplate(action.openUrl, checkout) } : {};
  };

  const latestRun = (runtime: TerminalRuntime, directory: string, actionId: string) => {
    const runs = runtime.listTerminals({ directory })
      .filter((run) => run.purpose.type === 'project-action' && run.purpose.actionId === actionId);
    return runs.find((run) => run.status === 'running')
      ?? runs.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0]
      ?? null;
  };

  const describeRun = (run: TerminalListing | null, sessionId: string | null) => (run
    ? { status: run.status, startedBy: startedByOf(run.purpose, sessionId), startedAt: run.createdAt }
    : null);

  const findAction = (actions: NonNullable<Awaited<ReturnType<typeof readActions>>>, requested: string | null) => {
    if (!requested) throw new OpenChamberControlError('name is required: an action id or name from actions.list', 400);
    const lowered = requested.toLowerCase();
    const found = actions.find((entry) => entry.action.id === requested)
      ?? actions.find((entry) => entry.action.name.toLowerCase() === lowered);
    if (!found) {
      throw new OpenChamberControlError(`No action ${requested} for this platform. Use one of: ${actions.map((entry) => entry.action.id).join(', ') || 'none'}`, 404);
    }
    return found;
  };

  const alreadyRunning = (run: TerminalListing, sessionId: string | null, url: { url?: string }) => {
    const startedBy = startedByOf(run.purpose, sessionId);
    const note = startedBy === 'you'
      ? 'Your run of this action is already going; it was not started again.'
      : `${startedBy === 'the user' ? 'The user' : 'Another session'} already runs this action, so no second copy started. That run is theirs:`
        + ' use it and read its output with actions.logs, but do not stop or restart it.';
    return { started: false, startedBy, directory: run.cwd, ...url, note };
  };

  const startingBySession = new Map<string, number>();
  const endedWhileStarting = new Set<string>();

  const startRun = async (runtime: TerminalRuntime, settings: ProjectActionsSettings, action: ProjectAction, directory: string, agentSessionId: string) => {
    startingBySession.set(agentSessionId, (startingBySession.get(agentSessionId) ?? 0) + 1);
    try {
      const result = await createRun(runtime, settings, action, directory, agentSessionId);
      if (result.started && endedWhileStarting.has(agentSessionId)) {
        await runtime.closeTerminal(result.terminalId);
        throw new OpenChamberControlError(`${action.name} was not started: this session was archived or deleted meanwhile`, 409);
      }
      return result;
    } finally {
      const left = (startingBySession.get(agentSessionId) ?? 1) - 1;
      if (left > 0) startingBySession.set(agentSessionId, left);
      else {
        startingBySession.delete(agentSessionId);
        endedWhileStarting.delete(agentSessionId);
      }
    }
  };

  const createRun = async (runtime: TerminalRuntime, settings: ProjectActionsSettings, action: ProjectAction, directory: string, agentSessionId: string) => {
    const executionId = `agent-${crypto.randomUUID()}`;
    const shell = asNonEmptyString(settings.terminalShell) ?? 'auto';
    const loginShells: unknown[] = Array.isArray(settings.terminalLoginShells) ? settings.terminalLoginShells : [];
    let terminalId: string;
    try {
      terminalId = await runtime.createSession({
        sessionId: executionId, cwd: directory, cols: 120, rows: 32, shell, loginShell: loginShells.includes(shell),
        mode: 'command', command: normalizeCommand(action.command), purpose: { type: 'project-action', actionId: action.id, executionId },
      }, agentSessionId);
    } catch (error) {
      throw new OpenChamberControlError(`Could not start ${action.name}: ${error instanceof Error ? error.message : String(error)}`, 400);
    }
    return { terminalId, started: terminalId === executionId, run: runtime.listTerminals({ directory }).find((run) => run.sessionId === terminalId) };
  };

  const describeReadiness = (runtime: TerminalRuntime, terminalId: string, readiness: RunReadiness) => {
    const seconds = Math.round(readyWait.limitMs / 1000);
    const answered = (status: number | null) => (status === null ? 'does not answer yet' : `still answers HTTP ${status}`);
    const output = () => runtime.readTerminal(terminalId, { maxBytes: OUTPUT_TAIL_BYTES })?.text ?? '';
    const again = ' Call actions.run again to keep waiting: it starts no second copy.';
    if (readiness.state === 'ready') {
      return { ready: true, url: readiness.url, note: `It is up: ${readiness.url} answered HTTP ${readiness.httpStatus}.` };
    }
    if (readiness.state === 'exited') {
      const code = readiness.exitCode === null ? 'without an exit code' : `with exit code ${readiness.exitCode}`;
      const note = !readiness.url
        ? `It finished ${code}.`
        : readiness.exitCode === 0
          ? `Its command finished with exit code 0, but ${readiness.url} ${answered(readiness.httpStatus)} after ${seconds} seconds.`
          : `It ended ${code} before ${readiness.url} answered.`;
      return { ready: false, exitCode: readiness.exitCode, output: output(), note: `${note} output is the end of what it printed.` };
    }
    if (readiness.state === 'no-address') {
      return { ready: false, note: 'It runs, and neither the action nor its output names an address, so OpenChamber cannot tell whether it is ready; read actions.logs.' };
    }
    return {
      ready: false,
      output: output(),
      note: readiness.url
        ? `Still starting after ${seconds} seconds: ${readiness.url} ${answered(readiness.httpStatus)}. output is the end of what it printed.${again}`
        : `Still running after ${seconds} seconds, and its output names no address. output is the end of what it printed.${again}`,
    };
  };

  const execute = async (action: string, input: ControlInput, context: { directory: string | null; sessionId: string | null; signal?: AbortSignal | undefined }) => {
    const settings = await readEnabledSettings();
    if (!settings) throw new OpenChamberControlError('The project actions tool is turned off in OpenChamber settings', 403);
    const { directory, sessionId } = context;
    if (!directory) throw new OpenChamberControlError("This call carries no session folder, so it has no project's actions", 400);
    if (SPACE_DIRECTORY.test(directory)) {
      throw new OpenChamberControlError('This session runs in an isolated space, where project actions do not run from here. The user runs them from the actions menu', 400);
    }
    const runtime = getTerminalRuntime();
    if (!runtime) throw new OpenChamberControlError('Project actions are not available on this server', 503);
    const actions = await readActions(directory, settings);
    if (!actions) throw new OpenChamberControlError("This session's folder belongs to no OpenChamber project, so it has no actions", 404);

    if (action === 'actions.list') {
      return {
        platform: currentPlatform ?? platform,
        actions: await Promise.all(actions.map(async ({ action: entry, directory: runDirectory, needsTrust }) => ({
          id: entry.id,
          name: entry.name,
          command: entry.command,
          directory: runDirectory,
          ...await urlOf(entry, runDirectory),
          needsTrust,
          run: describeRun(latestRun(runtime, runDirectory, entry.id), sessionId),
        }))),
      };
    }

    const { action: chosen, directory: runDirectory, needsTrust } = findAction(actions, asNonEmptyString(input.name));
    const current = latestRun(runtime, runDirectory, chosen.id);

    if (action === 'actions.run') {
      if (needsTrust) throw new OpenChamberControlError(UNTRUSTED_NOTE, 403);
      if (!sessionId) throw new OpenChamberControlError('actions.run needs the calling session', 400);
      const url = await urlOf(chosen, runDirectory);
      const { started, run, terminalId } = await startRun(runtime, settings, chosen, runDirectory, sessionId);
      const readiness = await waitForRun({ readTerminal: runtime.readTerminal, probe: probeUrl, ...readyWait }, terminalId, {
        url: url.url ?? null, waitForExit: started || (run !== undefined && startedByOf(run.purpose, sessionId) === 'you'), signal: context.signal,
      });
      if (!readiness) throw new OpenChamberControlError('actions.run was cancelled while it waited for the run to be ready; the run goes on', 499);
      const outcome = describeReadiness(runtime, terminalId, readiness);
      if (!started && run) {
        const answer = alreadyRunning(run, sessionId, url);
        return { ...answer, ...outcome, note: `${outcome.note} ${answer.note}` };
      }
      return {
        started: true,
        id: chosen.id,
        directory: runDirectory,
        ...url,
        ...outcome,
        note: readiness.state === 'exited' ? outcome.note : `${outcome.note} It runs in the background and shows in the user's actions menu as started by you.`
          + ' Read its output with actions.logs, and stop it with actions.stop once it is no longer needed.'
          + ' It also stops when this session is archived or OpenChamber quits.',
      };
    }

    if (!current) throw new OpenChamberControlError(`${chosen.name} has not run in ${runDirectory}; actions.run starts it`, 404);

    if (action === 'actions.logs') {
      const read = runtime.readTerminal(current.sessionId, Number.isFinite(input.maxBytes) ? { maxBytes: Number(input.maxBytes) } : {});
      if (!read) throw new OpenChamberControlError(`${chosen.name} is no longer running and its output is gone`, 404);
      return { id: chosen.id, status: read.status, exitCode: read.exitCode, startedBy: startedByOf(read.purpose, sessionId), text: read.text, truncated: read.truncated };
    }

    if (current.status !== 'running') return { stopped: false, id: chosen.id, note: `${chosen.name} is not running` };
    const startedBy = startedByOf(current.purpose, sessionId);
    if (startedBy !== 'you') {
      throw new OpenChamberControlError(`${chosen.name} was started by ${startedBy}, so only they stop it. Ask the user if it has to stop`, 403);
    }
    await runtime.closeTerminal(current.sessionId);
    return { stopped: true, id: chosen.id };
  };

  const stopSessionRuns = async (sessionId: string) => {
    if (startingBySession.has(sessionId)) endedWhileStarting.add(sessionId);
    const runtime = getTerminalRuntime();
    if (!runtime) return 0;
    const owned = runtime.listTerminals().filter((run) => run.status === 'running'
      && run.purpose.type === 'project-action' && run.purpose.agentSessionId === sessionId);
    await Promise.allSettled(owned.map((run) => runtime.closeTerminal(run.sessionId)));
    return owned.length;
  };

  return { execute, hasActions, stopSessionRuns };
};
