// The project's worktree setup commands, run inside a space after its code arrived (DESIGN.md,
// "Code in and out"; STAGES.md, stage 5d-4). They are the commands OpenChamber runs for a new
// worktree on the host, chosen by the client the same way, the shared ones only after the user
// trusted them; here they run in the space, as the space user, one after the other, and stop at
// the first that fails, as the host's `&&` chain does.
//
// A run is one process's memory while it goes: which command runs now. The record keeps what
// the user must still see after a restart of the host: that a run began, that it finished, or
// which command failed with the end of its output. A record that says a run began, with no run
// in this process, is a run the host did not live to see end, and is listed as interrupted.
//
// Everything a command prints comes from the project's code and the agent's space: it is text
// to show, kept short, with the terminal's control sequences taken out, and never anything else.

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { IMAGE_BASH, IMAGE_SH, IMAGE_TIMEOUT } from './layout.js';

// The host's own limits, `project-setup.js`: 50 shared commands and 50 personal ones, merged.
export const MAX_SETUP_COMMANDS = 100;
export const MAX_SETUP_COMMAND_LENGTH = 4000;

/** The commands of a run, as the client resolved them: blank ones are dropped. */
export const setupCommandsSchema = z.array(z.string().max(MAX_SETUP_COMMAND_LENGTH))
  .max(MAX_SETUP_COMMANDS)
  .transform((commands) => commands.filter((command) => command.trim() !== ''));

// One command may run this long inside; `timeout` then ends it and everything it started, which
// a kill of the host's `docker exec` would not. The host waits a minute longer for the answer.
const COMMAND_TIME_LIMIT_SECONDS = 3600;
const COMMAND_KILL_AFTER_SECONDS = 10;
const HOST_WAIT_MS = (COMMAND_TIME_LIMIT_SECONDS + 60) * 1000;
// `timeout` answers this code when the time limit ended the command.
const TIMED_OUT_EXIT_CODE = 124;
// How much of the output the host reads, and how much of its end it keeps for the user.
const OUTPUT_WINDOW_BYTES = 256 * 1024;
export const MAX_KEPT_OUTPUT_LINES = 200;
export const MAX_KEPT_OUTPUT_CHARACTERS = 32 * 1024;

// Runs in the space's project, with the space's own environment, so a command finds what the
// agent finds: the corridor's proxy variables and the space's PATH. The script uses only shell
// builtins and absolute paths, so no PATH decides what the host runs; the user's command gets
// the space's PATH. Its error output joins the rest, in the order it was printed.
const RUN_SCRIPT = `cd -- "$1" || exit 1; exec ${IMAGE_BASH} -c "$2" 2>&1`;

/** `$ROOT_PROJECT_PATH` and its older name, as the host's worktrees substitute them: here, the project inside the space. */
const substituteProjectPath = (command, projectPath) => command
  .replace(/\$\{?ROOT_PROJECT_PATH\}?/g, projectPath)
  .replace(/\$\{?ROOT_WORKTREE_PATH\}?/g, projectPath);

// Whole sequences first: operating-system commands with their text, such as a link, up to their
// end; colour and cursor sequences; any other escape. Then every control character but a tab and a
// line break, the one-byte controls of the C1 range, and the marks that turn text direction.
// eslint-disable-next-line no-control-regex
const TERMINAL_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]?|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The end of a command's output as the user reads it: a line that a progress bar rewrote with
 * carriage returns is what it said last, the terminal's sequences are gone, and at most the last
 * 200 lines and 32 KiB are kept.
 */
export const keptOutputOf = (text) => {
  const lines = String(text)
    .split('\n')
    .map((line) => line.split('\r').filter((part) => part !== '').at(-1) ?? '')
    .map((line) => line.replace(TERMINAL_SEQUENCE, ''));
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
  const kept = lines.slice(-MAX_KEPT_OUTPUT_LINES).join('\n');
  return kept.length > MAX_KEPT_OUTPUT_CHARACTERS ? kept.slice(-MAX_KEPT_OUTPUT_CHARACTERS) : kept;
};

/**
 * `exec` is the place's; `records` the host's records of spaces; `announce(spaceId)` tells the
 * clients that a space's setup moved on, so they read the list again.
 */
export function createSpaceSetup({ exec, records, announce = () => {}, logger = console, now = () => new Date() }) {
  // The runs under way, by space id: which command of how many, and when the run began.
  const runs = new Map();

  const remember = (spaceId, setup) => {
    // A record that is gone, with its space, or unreadable keeps nothing; the run still ends.
    try {
      records.update(spaceId, { setup });
    } catch (error) {
      logger.warn?.(`[spaces] the setup of space ${spaceId} could not be remembered: ${error?.code ?? error?.message ?? error}`);
    }
  };

  /** One command in the space. Resolves `{ exitCode, timedOut, output }`; a failure of the place is the command's failure. */
  const runOne = async (spaceId, projectPath, command) => {
    const began = now().getTime();
    // 124 is also what a command of the project's own may answer, `timeout 30 curl` among them:
    // it counts as the hour only when the hour has passed.
    const hourPassed = () => now().getTime() - began >= COMMAND_TIME_LIMIT_SECONDS * 1000;
    const argv = [
      IMAGE_TIMEOUT, '-k', String(COMMAND_KILL_AFTER_SECONDS), String(COMMAND_TIME_LIMIT_SECONDS),
      IMAGE_SH, '-c', RUN_SCRIPT, 'openchamber-setup', projectPath, substituteProjectPath(command, projectPath),
    ];
    try {
      // `killTree`, so a host that quits takes its `docker exec` along; the command inside then
      // runs to its end or its time limit, and the host lists the run as interrupted.
      const result = await exec(spaceId, argv, { timeoutMs: HOST_WAIT_MS, maxOutputBytes: OUTPUT_WINDOW_BYTES, keepTail: true, killTree: true });
      return {
        exitCode: result.code,
        timedOut: result.code === TIMED_OUT_EXIT_CODE && hourPassed(),
        // The runtime's own complaint, a container that stopped among them, comes on stderr.
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

  /**
   * Starts the commands in the background and answers at once. One run per space at a time.
   * `projectPath` is the project inside the space, where they run.
   */
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

  /**
   * The setup as the list carries it, from this process's run while one goes and from the record
   * otherwise. The output is not here: the list is read often, and the output only when asked.
   */
  const describe = (spaceId, record) => {
    const run = runs.get(spaceId);
    if (run) return { state: 'running', index: run.index, total: run.total, command: run.command };
    const kept = record?.setup ?? null;
    if (kept === null) return null;
    if (kept.state === 'running') return { state: 'interrupted', total: kept.total };
    if (kept.state === 'done') return { state: 'done', total: kept.total };
    // The run's span, for the client to read the gatekeeper's refusals within; null from a record before it was kept.
    return {
      state: 'failed', index: kept.index, total: kept.total, command: kept.command, exitCode: kept.exitCode, timedOut: kept.timedOut,
      startedAt: kept.startedAt ?? null, finishedAt: kept.finishedAt,
    };
  };

  /** The end of the failed command's output, or null when no command failed. */
  const outputOf = (record) => (record?.setup?.state === 'failed' ? record.setup.output : null);

  return { start, isRunning, describe, outputOf };
}
