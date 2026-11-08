import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSecretRequests } from './secret-request.js';
import { createSecretLeases, redactSecrets, secretRunCommandLine, SECRET_LEASE_MS } from './secret-run.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ enabled = true, now, hasUnreadChat } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-secret-run-'));
  temporaryDirectories.push(directory);
  const onWaitChange = vi.fn();
  const leases = createSecretLeases({ now });
  const requests = createSecretRequests({ isEnabled: async () => enabled, files: null, onWaitChange, hasUnreadChat, leases });
  return { directory, requests, onWaitChange, leases };
};

// The real runtime, so the child, its environment and its output are what a user gets.
const printToken = {
  program: process.execPath,
  args: ['-e', 'console.log("token is " + process.env.API_TOKEN); console.error("user " + process.env.API_USER); process.exit(3)'],
  reason: 'To log in to the staging API.',
  inputs: [{ env: 'API_TOKEN', label: 'Staging API token' }, { env: 'API_USER', label: 'User name' }],
};
const call = (directory, extra = {}) => ({ sessionId: 'ses_1', callId: 'call_1', directory, authorized: true, ...extra });
// The call starts waiting once its checks have run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('secret.run', () => {
  it('runs the command once with the values in its environment and keeps them out of the result', async () => {
    const { directory, requests, onWaitChange } = await createHarness();
    const pending = requests.run(printToken, call(directory));
    await settle();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN', 'API_USER'], reused: [] });
    expect(onWaitChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting', title: 'Staging API token, User name' }));

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1', API_USER: 'alice-secret' } }))
      .resolves.toEqual({ status: 'submitted' });
    const result = await pending;

    expect(result.answer).toEqual({ status: 'ran', outcome: 'exited', exitCode: 3 });
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.stderr.trim()).toBe('user [secret:API_USER]');
    expect(result.remembered).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/tok-secret-1|alice-secret/);
  });

  it('runs in the session directory', async () => {
    const { directory, requests } = await createHarness();
    const pending = requests.run({ ...printToken, args: ['-e', 'console.log(process.cwd())'], inputs: [printToken.inputs[0]] }, call(directory));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    expect((await pending).stdout.trim()).toBe(await fs.realpath(directory));
  });

  it('reuses only the fields the user let the chat remember, and asks for the rest', async () => {
    const { directory, requests } = await createHarness();
    const first = requests.run(printToken, call(directory));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1', API_USER: 'alice-secret' }, remember: ['API_TOKEN'] });
    expect((await first).remembered).toEqual(['API_TOKEN']);

    const second = requests.run(printToken, call(directory, { callId: 'call_2' }));
    await settle();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_2' })).toEqual({ fields: ['API_USER'], reused: ['API_TOKEN'] });
    // A value for a field the card did not ask for is refused.
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'bob', API_TOKEN: 'other' } })).rejects.toMatchObject({ statusCode: 400 });
    requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'bob-secret' } });
    const result = await second;
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.stderr.trim()).toBe('user [secret:API_USER]');
  });

  it('runs at once when every field is remembered, in this session only', async () => {
    const { directory, requests, leases, onWaitChange } = await createHarness();
    leases.keep('ses_1', 'API_TOKEN', 'tok-secret-1');
    const result = await requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    expect(onWaitChange).not.toHaveBeenCalled();
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');

    const other = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory, { sessionId: 'ses_2' }));
    await settle();
    expect(requests.fields({ sessionId: 'ses_2', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [] });
    requests.answer({ sessionId: 'ses_2', callId: 'call_1', declined: true });
    await expect(other).resolves.toMatchObject({ answer: { status: 'declined' } });
  });

  it('forgets a remembered value when its time is up or the agent forgets it', async () => {
    let clock = 1_000;
    const leases = createSecretLeases({ now: () => clock });
    leases.keep('ses_1', 'A', 'one');
    leases.keep('ses_1', 'B', 'two');
    clock += SECRET_LEASE_MS - 1;
    expect(leases.read('ses_1', 'A')).toBe('one');
    clock += 1;
    expect(leases.read('ses_1', 'A')).toBeNull();
    leases.keep('ses_1', 'A', 'again');
    expect(leases.forget('ses_1')).toBe(2);
    expect(leases.read('ses_1', 'A')).toBeNull();
  });

  it('does not run when the user declines', async () => {
    const { directory, requests } = await createHarness();
    const marker = path.join(directory, 'ran');
    const pending = requests.run({ ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] }, call(directory));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await expect(pending).resolves.toMatchObject({ answer: { status: 'declined' } });
    await expect(fs.access(marker)).rejects.toThrow();
    // A card that stopped waiting has no fields to read.
    expect(() => requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('stops the command when the call is stopped', async () => {
    const { directory, requests } = await createHarness();
    const controller = new AbortController();
    const pending = requests.run({ ...printToken, args: ['-e', 'setTimeout(() => {}, 60000)'], inputs: [printToken.inputs[0]] }, call(directory, { signal: controller.signal }));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
  });

  it('reports a timeout and a program that does not start, with the values out of the message', async () => {
    const { directory, requests } = await createHarness();
    const slow = requests.run({ ...printToken, args: ['-e', 'setTimeout(() => {}, 60000)'], inputs: [printToken.inputs[0]], timeoutMs: 300 }, call(directory));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    await expect(slow).resolves.toMatchObject({ answer: { status: 'ran', outcome: 'timeout', exitCode: null } });

    const missing = requests.run({ ...printToken, program: 'no-such-program-oc', inputs: [printToken.inputs[0]] }, call(directory, { callId: 'call_2' }));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_TOKEN: 'x-1234' } });
    await expect(missing).resolves.toMatchObject({ answer: { outcome: 'not-started' }, error: expect.stringContaining('no-such-program-oc') });
  });

  it('refuses a call that did not come through the secret tool, or that is malformed, before any card', async () => {
    const { directory, requests, onWaitChange } = await createHarness();
    await expect(requests.run(printToken, call(directory, { authorized: false }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(requests.run({ ...printToken, program: '' }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, inputs: [{ env: 'BAD-NAME', label: 'x' }] }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, inputs: [printToken.inputs[0], printToken.inputs[0]] }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, args: 'oops' }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    expect(onWaitChange).not.toHaveBeenCalled();
  });

  it('does not wait or run when the user wrote in the chat first, remembered values or not', async () => {
    const { directory, requests, onWaitChange, leases } = await createHarness({ hasUnreadChat: async () => true });
    await expect(requests.run(printToken, call(directory))).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    expect(onWaitChange).not.toHaveBeenCalled();

    leases.keep('ses_1', 'API_TOKEN', 'tok-secret-1');
    const marker = path.join(directory, 'ran');
    const remembered = { ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], inputs: [printToken.inputs[0]] };
    await expect(requests.run(remembered, call(directory))).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('refuses a value no environment can hold, so the runtime never quotes it', async () => {
    const { directory, requests } = await createHarness();
    const pending = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    await settle();
    const nul = String.fromCharCode(0);
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: `head${nul}tail` } })).rejects.toMatchObject({ statusCode: 400 });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await pending;
  });

  it('drops a secret cut in half where the output was cut at its limit', async () => {
    const { directory, requests } = await createHarness();
    const secret = `S${'k'.repeat(15_000)}END-OF-SECRET`;
    // About 1.05 MB, so the runner keeps the last 1 MB and cuts one copy apart.
    const script = 'for (let i = 0; i < 70; i++) process.stdout.write(process.env.API_TOKEN + "\\n")';
    const pending = requests.run({ ...printToken, args: ['-e', script], inputs: [printToken.inputs[0]] }, call(directory));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: secret } });
    const result = await pending;
    expect(result.truncated).toEqual({ stdout: true, stderr: false });
    expect(result.stdout).not.toContain('END-OF-SECRET');
    expect(result.stdout).not.toContain('kkkk');
    expect(result.stdout).toContain('[secret:API_TOKEN]');
  });

  it('hides a repeating secret cut at the limit, where a shifted match would leave a piece', async () => {
    const { directory, requests } = await createHarness();
    const secret = '0123456789'.repeat(1500);
    const script = 'for (let i = 0; i < 70; i++) process.stdout.write(process.env.API_TOKEN + "\\n")';
    const pending = requests.run({ ...printToken, args: ['-e', script], inputs: [printToken.inputs[0]] }, call(directory));
    await settle();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: secret } });
    const { stdout } = await pending;
    expect(stdout).not.toMatch(/\d/);
  });

  it('answers 403 while the tool is off', async () => {
    const { directory, requests } = await createHarness({ enabled: false });
    await expect(requests.run(printToken, call(directory))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('secret run helpers', () => {
  it('replaces every value, a longer one before one inside it', () => {
    expect(redactSecrets('a=abc123 b=abc', { SHORT: 'abc', LONG: 'abc123' })).toBe('a=[secret:LONG] b=[secret:SHORT]');
  });

  it('hides overlapping occurrences together, and the end of a value a cut text starts with', () => {
    expect(redactSecrets('x abab ababab y', { V: 'abab' })).toBe('x [secret:V] [secret:V] y');
    expect(redactSecrets('cdef tail', { V: 'abcdef' }, { cutAtStart: true })).toBe('[secret:V] tail');
    expect(redactSecrets('cdef tail', { V: 'abcdef' })).toBe('cdef tail');
  });

  it('quotes what is not plain and shows characters that would hide or reorder text', () => {
    expect(secretRunCommandLine('wrangler', ['deploy', '--env', 'prod'])).toBe('wrangler deploy --env prod');
    expect(secretRunCommandLine('sh', ['-c', "echo 'hi' && x"])).toBe("sh -c 'echo '\\''hi'\\'' && x'");
    expect(secretRunCommandLine('echo', [`safe${String.fromCharCode(0x202e)}txt`])).toBe("echo 'safe\\u{202E}txt'");
  });
});
