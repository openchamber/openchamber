
import { z } from 'zod';

import { SpaceError, spaceErrorProperty } from './errors.js';
import { IMAGE_BASH, IMAGE_SH, IMAGE_TIMEOUT } from './layout.js';
import { transferValue } from './code-transfer.js';
import type { CommandOptions, CommandResult } from './command-contracts.js';
import type { SpaceRecord, createSpaceRecords } from './space-records.js';

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

const substituteProjectPath = (command: string, projectPath: string) => command
  .replace(/\$\{?ROOT_PROJECT_PATH\}?/g, projectPath)
  .replace(/\$\{?ROOT_WORKTREE_PATH\}?/g, projectPath);

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const TERMINAL_SEQUENCE = new RegExp(`${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)?|${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}[@-_]?|(?![\\t\\n\\r])\\p{Cc}|[\\u202a-\\u202e\\u2066-\\u2069]`, 'gu');

export const keptOutputOf = <Text>(text: Text) => {
  const lines = String(text)
    .split('\n')
    .map((line) => line.split('\r').filter((part) => part !== '').at(-1) ?? '')
    .map((line) => line.replace(TERMINAL_SEQUENCE, ''));
  while (lines.length > 0 && transferValue(lines.at(-1), 'trim').trim() === '') lines.pop();
  const kept = lines.slice(-MAX_KEPT_OUTPUT_LINES).join('\n');
  return kept.length > MAX_KEPT_OUTPUT_CHARACTERS ? kept.slice(-MAX_KEPT_OUTPUT_CHARACTERS) : kept;
};

export interface SpaceSetupOptions {
  exec: (spaceId: string, argv: string[], options: CommandOptions) => Promise<CommandResult>;
  records: Pick<ReturnType<typeof createSpaceRecords>, 'update'>;
  announce?: (spaceId: string) => void;
  logger?: Pick<Console, 'warn'>;
  now?: () => Date;
}
interface SetupRun {
  index: number;
  total: number;
  command: string | undefined;
  startedAt: string;
}
export function createSpaceSetup({ exec, records, announce = () => {}, logger = console, now = () => new Date() }: SpaceSetupOptions) {
  const runs = new Map<string, SetupRun>();

  const remember = (spaceId: string, setup: SpaceRecord['setup']) => {
    try {
      records.update(spaceId, { setup });
    } catch (error) {
      logger.warn?.(`[spaces] the setup of space ${spaceId} could not be remembered: ${spaceErrorProperty(error, 'code') ?? spaceErrorProperty(error, 'message') ?? error}`);
    }
  };

  const runOne = async (spaceId: string, projectPath: string, command: string) => {
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
        output: keptOutputOf(spaceErrorProperty(error, 'message') ?? String(error)),
      };
    }
  };

  const runAll = async (spaceId: string, projectPath: string, commands: string[]) => {
    const run = runs.get(spaceId);
    try {
      for (const [index, command] of commands.entries()) {
        transferValue(run, 'index').index = index;
        transferValue(run, 'command').command = command;
        if (index > 0) announce(spaceId);
        const outcome = await runOne(spaceId, projectPath, command);
        if (outcome.exitCode !== 0) {
          remember(spaceId, { state: 'failed', total: commands.length, index, command, ...outcome, startedAt: transferValue(run, 'startedAt').startedAt, finishedAt: now().toISOString() });
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

  const start = (spaceId: string, { projectPath, commands }: { projectPath: string; commands: string[] }) => {
    if (runs.has(spaceId)) throw new SpaceError('space_setup_running', 'The setup commands of this space are still running. Wait for them to finish.');
    if (commands.length === 0) throw new SpaceError('invalid_setup_commands', 'There are no setup commands to run.');
    const startedAt = now().toISOString();
    runs.set(spaceId, { index: 0, total: commands.length, command: commands[0], startedAt });
    remember(spaceId, { state: 'running', total: commands.length, startedAt });
    announce(spaceId);
    void runAll(spaceId, projectPath, commands);
  };

  const isRunning = (spaceId: string) => runs.has(spaceId);

  const describe = (spaceId: string, record: SpaceRecord | null) => {
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

  const outputOf = (record: SpaceRecord | null) => (record?.setup?.state === 'failed' ? record.setup.output : null);

  return { start, isRunning, describe, outputOf };
}
