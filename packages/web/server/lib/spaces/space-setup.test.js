// The setup commands inside a space, over a stand-in `exec` that answers per command and real
// records in a temporary folder. What is under test is the order, where they run, what a failure
// keeps for the user, and what the list says while a run goes and after the host lost it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { IMAGE_BASH, IMAGE_SH, IMAGE_TIMEOUT } from './layout.js';
import { createSpaceRecords } from './space-records.js';
import { MAX_KEPT_OUTPUT_CHARACTERS, MAX_KEPT_OUTPUT_LINES, createSpaceSetup, keptOutputOf, setupCommandsSchema } from './space-setup.js';

const ID = 'abcdef012345';
const PROJECT_PATH = `/spaces/${ID}/project`;
const quiet = { warn: () => {} };
const folders = [];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (check, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(5);
  return check();
};

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A setup over records in a fresh folder and an `exec` that answers each command from `answers`. */
const setupWith = (answers = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-setup-'));
  folders.push(dataDir);
  const records = createSpaceRecords({ dataDir, logger: quiet });
  records.write(ID, { network: { mode: 'allowlist', domains: [] }, spacePath: PROJECT_PATH });
  const calls = [];
  const announced = [];
  const held = new Map();
  const exec = async (spaceId, argv, options) => {
    const command = argv.at(-1);
    calls.push({ spaceId, argv, options });
    if (held.has(command)) await held.get(command).promise;
    const answer = answers[command] ?? { code: 0, stdout: '', stderr: '' };
    if (answer instanceof Error) throw answer;
    return answer;
  };
  /** Makes the named command wait until the test lets it go. */
  const hold = (command) => {
    let release = () => {};
    const promise = new Promise((resolve) => { release = resolve; });
    held.set(command, { promise, release });
    return release;
  };
  // The clock stands still unless a test moves it.
  const clock = { at: Date.parse('2026-09-28T10:00:00.000Z') };
  const exec2 = async (spaceId, argv, options) => {
    const answer = await exec(spaceId, argv, options);
    if (answers.advanceMs) clock.at += answers.advanceMs;
    return answer;
  };
  const setup = createSpaceSetup({ exec: exec2, records, announce: (spaceId) => announced.push(spaceId), logger: quiet, now: () => new Date(clock.at) });
  return { setup, records, calls, announced, hold };
};

describe('setup commands inside a space', () => {
  it('runs each command in the project inside, one after the other, under a time limit, and remembers that they finished', async () => {
    const { setup, records, calls, announced } = setupWith();
    setup.start(ID, { projectPath: PROJECT_PATH, commands: ['npm ci', 'cp "$ROOT_PROJECT_PATH/.env.example" ${ROOT_WORKTREE_PATH}/.env'] });
    expect(await until(() => !setup.isRunning(ID))).toBe(true);

    expect(calls.map((call) => call.argv)).toEqual([
      [IMAGE_TIMEOUT, '-k', '10', '3600', IMAGE_SH, '-c', `cd -- "$1" || exit 1; exec ${IMAGE_BASH} -c "$2" 2>&1`, 'openchamber-setup', PROJECT_PATH, 'npm ci'],
      [IMAGE_TIMEOUT, '-k', '10', '3600', IMAGE_SH, '-c', `cd -- "$1" || exit 1; exec ${IMAGE_BASH} -c "$2" 2>&1`, 'openchamber-setup', PROJECT_PATH, `cp "${PROJECT_PATH}/.env.example" ${PROJECT_PATH}/.env`],
    ]);
    // The host waits past the time limit inside, reads a window of the output, and a quit takes its `docker exec` along.
    expect(calls[0].options).toEqual({ timeoutMs: 3_660_000, maxOutputBytes: 256 * 1024, keepTail: true, killTree: true });
    expect(calls.every((call) => call.spaceId === ID && call.options.target === undefined)).toBe(true);
    expect(records.read(ID).record.setup).toEqual({ state: 'done', total: 2, finishedAt: '2026-09-28T10:00:00.000Z' });
    expect(setup.describe(ID, records.read(ID).record)).toEqual({ state: 'done', total: 2 });
    expect(setup.outputOf(records.read(ID).record)).toBeNull();
    // Began, the second command, and the end.
    expect(announced).toEqual([ID, ID, ID]);
  });

  it('says which command runs while a run goes, and refuses a second run until it ends', async () => {
    const { setup, records, hold } = setupWith();
    const release = hold('npm ci');
    setup.start(ID, { projectPath: PROJECT_PATH, commands: ['npm ci', 'npm run build'] });
    expect(setup.describe(ID, records.read(ID).record)).toEqual({ state: 'running', index: 0, total: 2, command: 'npm ci' });
    expect(records.read(ID).record.setup).toEqual({ state: 'running', total: 2, startedAt: '2026-09-28T10:00:00.000Z' });
    expect(() => setup.start(ID, { projectPath: PROJECT_PATH, commands: ['true'] })).toThrow(expect.objectContaining({ code: 'space_setup_running' }));
    release();
    expect(await until(() => !setup.isRunning(ID))).toBe(true);
    expect(() => setup.start(ID, { projectPath: PROJECT_PATH, commands: [] })).toThrow(expect.objectContaining({ code: 'invalid_setup_commands' }));
  });

  it('stops at the first command that fails and keeps which one, how, and the end of what it printed', async () => {
    const printed = `${'\u001b[31mnpm ERR!\u001b[0m 403 Forbidden\n'}fetch 10%\rfetch 50%\rfetch 100%\n`;
    const { setup, records, calls } = setupWith({ 'npm ci': { code: 1, stdout: printed, stderr: '' } });
    setup.start(ID, { projectPath: PROJECT_PATH, commands: ['echo ok', 'npm ci', 'npm run build'] });
    expect(await until(() => !setup.isRunning(ID))).toBe(true);
    expect(calls).toHaveLength(2);
    const { record } = records.read(ID);
    expect(record.setup).toEqual({ state: 'failed', total: 3, index: 1, command: 'npm ci', exitCode: 1, timedOut: false, output: 'npm ERR! 403 Forbidden\nfetch 100%', finishedAt: '2026-09-28T10:00:00.000Z' });
    expect(setup.describe(ID, record)).toEqual({ state: 'failed', index: 1, total: 3, command: 'npm ci', exitCode: 1, timedOut: false });
    expect(setup.outputOf(record)).toBe('npm ERR! 403 Forbidden\nfetch 100%');
  });

  it('counts the time limit inside and a place that failed as the command failing', async () => {
    const limited = setupWith({ 'sleep 9999': { code: 124, stdout: '', stderr: '' }, advanceMs: 3_600_000 });
    limited.setup.start(ID, { projectPath: PROJECT_PATH, commands: ['sleep 9999'] });
    expect(await until(() => !limited.setup.isRunning(ID))).toBe(true);
    expect(limited.records.read(ID).record.setup).toMatchObject({ exitCode: 124, timedOut: true });

    // A command's own 124 before the hour is its own failure, not the limit.
    const own = setupWith({ 'timeout 30 curl https://example.com': { code: 124, stdout: '', stderr: '' }, advanceMs: 30_000 });
    own.setup.start(ID, { projectPath: PROJECT_PATH, commands: ['timeout 30 curl https://example.com'] });
    expect(await until(() => !own.setup.isRunning(ID))).toBe(true);
    expect(own.records.read(ID).record.setup).toMatchObject({ exitCode: 124, timedOut: false });

    const gone = setupWith({ 'npm ci': new SpaceError('space_not_running', 'Space abcdef012345 is stopped.') });
    gone.setup.start(ID, { projectPath: PROJECT_PATH, commands: ['npm ci'] });
    expect(await until(() => !gone.setup.isRunning(ID))).toBe(true);
    expect(gone.records.read(ID).record.setup).toMatchObject({ exitCode: null, timedOut: false, output: 'Space abcdef012345 is stopped.' });

    const hostWait = setupWith({ 'npm ci': new SpaceError('command_timeout', 'docker exec ran too long') });
    hostWait.setup.start(ID, { projectPath: PROJECT_PATH, commands: ['npm ci'] });
    expect(await until(() => !hostWait.setup.isRunning(ID))).toBe(true);
    expect(hostWait.records.read(ID).record.setup).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('lists a run the record says began, with no run in this process, as interrupted', () => {
    const { setup, records } = setupWith();
    records.update(ID, { setup: { state: 'running', total: 3, startedAt: '2026-09-28T09:00:00.000Z' } });
    expect(setup.describe(ID, records.read(ID).record)).toEqual({ state: 'interrupted', total: 3 });
    expect(setup.describe(ID, null)).toBeNull();
  });

  it('keeps a run going when its record is gone, the space removed meanwhile', async () => {
    const { setup, records, hold } = setupWith({ 'npm ci': { code: 2, stdout: 'x', stderr: '' } });
    const release = hold('npm ci');
    setup.start(ID, { projectPath: PROJECT_PATH, commands: ['npm ci'] });
    records.remove(ID);
    release();
    expect(await until(() => !setup.isRunning(ID))).toBe(true);
    expect(records.read(ID)).toEqual({ status: 'missing', record: null });
  });
});

describe('what the user reads of a command', () => {
  it('keeps the last lines as a terminal last showed them, without its control sequences', () => {
    expect(keptOutputOf('a\r\nb\u0007\u001b[2Kc\n\n')).toBe('a\nbc');
    const many = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
    const kept = keptOutputOf(many).split('\n');
    expect(kept).toHaveLength(MAX_KEPT_OUTPUT_LINES);
    expect(kept.at(-1)).toBe('line 499');
    expect(keptOutputOf('y'.repeat(100_000))).toHaveLength(MAX_KEPT_OUTPUT_CHARACTERS);
    // A link's whole sequence goes, its address with it; so do the one-byte controls and the direction marks.
    expect(keptOutputOf('see \u001b]8;;https://evil.example/\u0007here\u001b]8;;\u0007 done')).toBe('see here done');
    expect(keptOutputOf('a\u001b]0;title\u001b\\b')).toBe('ab');
    expect(keptOutputOf('x\u009b31my\u0085')).toBe('x31my');
    expect(keptOutputOf('file\u202egnp.exe \u2066z\u2069')).toBe('filegnp.exe z');
  });

  it('takes the list of commands as the host keeps it, without blank ones', () => {
    expect(setupCommandsSchema.parse(['npm ci', '  ', ''])).toEqual(['npm ci']);
    // 50 shared and 50 personal, as the host keeps them.
    expect(setupCommandsSchema.safeParse(Array.from({ length: 100 }, () => 'true')).success).toBe(true);
    expect(setupCommandsSchema.safeParse(Array.from({ length: 101 }, () => 'true')).success).toBe(false);
    expect(setupCommandsSchema.safeParse(['x'.repeat(4001)]).success).toBe(false);
    expect(setupCommandsSchema.safeParse('npm ci').success).toBe(false);
  });
});
