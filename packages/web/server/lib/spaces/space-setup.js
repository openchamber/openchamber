
import { z } from 'zod';

import { SpaceError } from './errors.js';
import { IMAGE_BASH, IMAGE_SH, IMAGE_TIMEOUT } from './layout.js';

export const MAX_SETUP_COMMANDS = 100;
export const MAX_SETUP_COMMAND_LENGTH = 4000;

export const setupCommandsSchema = z.array(z.string().max(MAX_SETUP_COMMAND_LENGTH))
  .max(MAX_SETUP_COMMANDS)
  .transform((commands) => commands.filter((command) => command.trim() !== ''));

const COMMAND_TIME_LIMIT_SECONDS = 3600;
const COMMAND_KILL_AFTER_SECONDS = 10;
const HOST_WAIT_MS = (COMMAND_TIME_LIMIT_SECONDS + 60) * 1000;
const TIMED_OUT_EXIT_CODE = 124;
const OUTPUT_WINDOW_BYTES = 256 * 1024;
export const MAX_KEPT_OUTPUT_LINES = 200;
export const MAX_KEPT_OUTPUT_CHARACTERS = 32 * 1024;

const RUN_SCRIPT = `cd -- "$1" || exit 1; exec ${IMAGE_BASH} -c "$2" 2>&1`;

const substituteProjectPath = (command, projectPath) => command
  .replace(/\$\{?ROOT_PROJECT_PATH\}?/g, projectPath)
  .replace(/\$\{?ROOT_WORKTREE_PATH\}?/g, projectPath);

// oxlint-disable-next-line no-control-regex
const TERMINAL_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]?|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export const keptOutputOf = (text) => {
  const lines = String(text)
    .split('\n')
    .map((line) => line.split('\r').filter((part) => part !== '').at(-1) ?? '')
    .map((line) => line.replace(TERMINAL_SEQUENCE, ''));
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
  const kept = lines.slice(-MAX_KEPT_OUTPUT_LINES).join('\n');
  return kept.length > MAX_KEPT_OUTPUT_CHARACTERS ? kept.slice(-MAX_KEPT_OUTPUT_CHARACTERS) : kept;
};

export function createSpaceSetup({ exec, records, announce = () => {}, logger = console, now = () => new Date() }) {
  const runs = new Map();

  const remember = (spaceId, setup) => {
    try {
      records.update(spaceId, { setup });
    } catch (error) {
      logger.warn?.(`[spaces] the setup of space ${spaceId} could not be remembered: ${error?.code ?? error?.message ?? error}`);
    }
  };

  const runOne = async (spaceId, projectPath, command) => {
    const began = now().getTime();
    const hourPassed = () => now().getTime() - began >= COMMAND_TIME_LIMIT_SECONDS * 1000;
    const argv = [
      IMAGE_TIMEOUT, '-k', String(COMMAND_KILL_AFTER_SECONDS), String(COMMAND_TIME_LIMIT_SECONDS),
      IMAGE_SH, '-c', RUN_SCRIPT, 'openchamber-setup', projectPath, substituteProjectPath(command, projectPath),
    ];
    try {
      const result = await exec(spaceId, argv, { timeoutMs: HOST_WAIT_MS, maxOutputBytes: OUTPUT_WINDOW_BYTES, keepTail: true, killTree: true });
      return {
        exitCode: result.code,
        timedOut: result.code === TIMED_OUT_EXIT_CODE && hourPassed(),
        output: keptOutputOf([result.stdout, result.stderr].filter((part) => part !== '').join('\n')),
      };
    } catch (error) {
      return {
        exitCode: null,
        timedOut: error instanceof SpaceError && error.code === 'command_timeout',
        output: keptOutputOf(error?.message ?? String(error)),
      };
    }
  };

  const runAll = async (spaceId, projectPath, commands) => {
    const run = runs.get(spaceId);
    try {
      for (const [index, command] of commands.entries()) {
        run.index = index;
        run.command = command;
        if (index > 0) announce(spaceId);
        const outcome = await runOne(spaceId, projectPath, command);
        if (outcome.exitCode !== 0) {
          remember(spaceId, { state: 'failed', total: commands.length, index, command, ...outcome, startedAt: run.startedAt, finishedAt: now().toISOString() });
          logger.warn?.(`[spaces] setup command ${index + 1} of ${commands.length} failed in space ${spaceId}: exit ${outcome.exitCode}${outcome.timedOut ? ', timed out' : ''}`);
          return;
        }
      }
      remember(spaceId, { state: 'done', total: commands.length, finishedAt: now().toISOString() });
    } finally {
      runs.delete(spaceId);
      announce(spaceId);
    }
  };

  const start = (spaceId, { projectPath, commands }) => {
    if (runs.has(spaceId)) throw new SpaceError('space_setup_running', 'The setup commands of this space are still running. Wait for them to finish.');
    if (commands.length === 0) throw new SpaceError('invalid_setup_commands', 'There are no setup commands to run.');
    const startedAt = now().toISOString();
    runs.set(spaceId, { index: 0, total: commands.length, command: commands[0], startedAt });
    remember(spaceId, { state: 'running', total: commands.length, startedAt });
    announce(spaceId);
    void runAll(spaceId, projectPath, commands);
  };

  const isRunning = (spaceId) => runs.has(spaceId);

  const describe = (spaceId, record) => {
    const run = runs.get(spaceId);
    if (run) return { state: 'running', index: run.index, total: run.total, command: run.command };
    const kept = record?.setup ?? null;
    if (kept === null) return null;
    if (kept.state === 'running') return { state: 'interrupted', total: kept.total };
    if (kept.state === 'done') return { state: 'done', total: kept.total };
    return {
      state: 'failed', index: kept.index, total: kept.total, command: kept.command, exitCode: kept.exitCode, timedOut: kept.timedOut,
      startedAt: kept.startedAt ?? null, finishedAt: kept.finishedAt,
    };
  };

  const outputOf = (record) => (record?.setup?.state === 'failed' ? record.setup.output : null);

  return { start, isRunning, describe, outputOf };
}
