import { describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { createSpaceServerChannel, createSpaceToken } from './space-server.js';

const ID = 'a1b2c3d4e5f6';
const http = (status, body, headers = []) => `HTTP/1.1 ${status} OK\r\n${['Content-Type: application/json', ...headers].join('\r\n')}\r\n\r\n${body}`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

/**
 * A channel on a recording `exec`. `answers` are returned in turn, the last one repeats.
 * Nothing sleeps: the clock moves by the pause in `wait`, and by `secondsPerAttempt` for every exec.
 */
const channelWith = (...answers) => channelTaking(0, ...answers);

const channelTaking = (secondsPerAttempt, ...answers) => {
  const calls = [];
  let waits = 0;
  let clock = 1_000_000;
  const exec = async (spaceId, argv, options) => {
    calls.push({ spaceId, argv, options });
    clock += secondsPerAttempt * 1000;
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const wait = async (milliseconds) => { waits += 1; clock += milliseconds; };
  return { channel: createSpaceServerChannel({ exec, wait, now: () => clock }), calls, waits: () => waits };
};

describe('createSpaceToken', () => {
  it('is 32 random bytes in a form that needs no quoting', () => {
    expect(createSpaceToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSpaceToken()).not.toBe(createSpaceToken());
  });
});

describe('space server channel: token', () => {
  it('sends the token on stdin to a fixed script, through a temporary name, readable by the space user only', async () => {
    const { channel, calls } = channelWith(ok());
    await channel.writeToken(ID, 'the-token');

    expect(calls).toEqual([{
      spaceId: ID,
      argv: ['/bin/sh', '-c', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; umask 077; mkdir -p /home/space/.openchamber-space && chmod 700 /home/space/.openchamber-space && cat > /home/space/.openchamber-space/token.new && mv /home/space/.openchamber-space/token.new /home/space/.openchamber-space/token'],
      options: { stdin: 'the-token' },
    }]);
  });

  it('reads the token back from the space, with a short time limit', async () => {
    const token = createSpaceToken();
    const { channel, calls } = channelWith(ok(`${token}\n`));

    expect(await channel.readToken(ID)).toBe(token);
    expect(calls[0].argv).toEqual(['/bin/cat', '/home/space/.openchamber-space/token']);
    expect(calls[0].options.timeoutMs).toBe(10_000);
  });

  // The agent owns the token file.
  it.each([
    ['an empty file', ok('\n'), /is empty/],
    ['a file that holds something else', ok('not a token: $(reboot)\n'), /does not hold a token/],
    ['a token that is too short', ok('abc\n'), /does not hold a token/],
    ['a token that is too long', ok(`${'a'.repeat(129)}\n`), /does not hold a token/],
    ['a huge file', Object.assign(new Error('too much'), { code: 'command_output_too_large' }), /far too large/],
    ['a FIFO that never ends', Object.assign(new Error('too slow'), { code: 'command_timeout' }), /in time/],
  ])('rejects %s with a code of its own', async (title, answer, message) => {
    const { channel } = channelWith(answer);

    const error = await channel.readToken(ID).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('space_token_unreadable');
    expect(error.message).toMatch(message);
  });

  it('says when the token file cannot be read at all', async () => {
    const { channel } = channelWith({ code: 1, stdout: '', stderr: 'cat: /home/space/.openchamber-space/token: No such file or directory\n' });
    await expect(channel.readToken(ID)).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('No such file') });
  });

  it('says what failed inside the space', async () => {
    const { channel } = channelWith({ code: 1, stdout: '', stderr: 'cat: write error: No space left on device\n' });
    await expect(channel.writeToken(ID, 'x')).rejects.toMatchObject({ code: 'space_setup_failed', message: expect.stringContaining('No space left on device') });
  });
});

describe('space server channel: plugin link', () => {
  it('links only the plugin package, above every project of the space', async () => {
    const { channel, calls } = channelWith(ok());
    await channel.linkPlugin(ID);

    expect(calls[0].argv).toEqual([
      '/bin/sh', '-c', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; mkdir -p "$1/node_modules/@opencode" && ln -sfn "$2" "$1/node_modules/@opencode/plugin"',
      'sh', `/spaces/${ID}`, '/opt/openchamber-tools/node_modules/@opencode/plugin',
    ]);
  });
});

describe('space server channel: request', () => {
  it('puts the whole request into a curl config on stdin, so nothing of it is in an argument', async () => {
    const { channel, calls } = channelWith(ok(http(200, '{"authenticated":true}', ['Set-Cookie: a=1; Path=/', 'Set-Cookie: b=2'])));
    const body = JSON.stringify({ password: 'quote " backslash \\ newline \n tab \t end' });
    const answer = await channel.request(ID, { method: 'POST', path: '/auth/session', headers: { 'Content-Type': 'application/json', Cookie: 'oc=secret' }, body });

    expect(answer).toEqual({
      status: 200,
      headers: { 'content-type': ['application/json'], 'set-cookie': ['a=1; Path=/', 'b=2'] },
      body: '{"authenticated":true}',
    });
    expect(calls[0].argv).toEqual(['/usr/bin/curl', '--disable', '--noproxy', '*', '--silent', '--show-error', '--include', '--max-time', '20', '--config', '-']);
    expect(calls[0].options.stdin).toBe([
      'url = "http://127.0.0.1:27600/auth/session"',
      'request = "POST"',
      'header = "Expect:"',
      'header = "Content-Type: application/json"',
      'header = "Cookie: oc=secret"',
      'data-raw = "{\\"password\\":\\"quote \\\\\\" backslash \\\\\\\\ newline \\\\n tab \\\\t end\\"}"',
      '',
    ].join('\n'));
    expect(calls[0].options.timeoutMs).toBeGreaterThan(20_000);
  });

  it('puts --disable first and --noproxy on every request, whatever the space environment says', async () => {
    const { channel, calls } = channelWith(ok(http(200, '')));
    await channel.request(ID, { path: '/health' });
    await channel.waitUntilReady(ID).catch(() => {});

    // curl honours --disable only as its first argument. Without --noproxy the space's own
    // proxy variables send this request to the corridor: measured, the answer was
    // `curl: (1) Received HTTP/0.9 when not allowed`.
    for (const call of calls) expect(call.argv.slice(0, 4)).toEqual(['/usr/bin/curl', '--disable', '--noproxy', '*']);
  });

  it('sends a body that starts with @ as text, not as the content of a file', async () => {
    const { channel, calls } = channelWith(ok(http(200, '')));
    await channel.request(ID, { method: 'POST', path: '/x', body: '@/home/space/.openchamber-space/token' });

    const lines = calls[0].options.stdin.split('\n');
    expect(lines).toContain('data-raw = "@/home/space/.openchamber-space/token"');
    expect(lines.some((line) => line.startsWith('data-binary') || line.startsWith('data ='))).toBe(false);
  });

  it('resolves any status, and keeps a body that holds a blank line', async () => {
    const { channel } = channelWith(ok(http(401, 'first\r\n\r\nsecond')));
    expect(await channel.request(ID, { path: '/api/session' })).toMatchObject({ status: 401, body: 'first\r\n\r\nsecond' });
  });

  it('keeps a line break inside a header value from becoming a second config line', async () => {
    const { channel, calls } = channelWith(ok(http(200, '')));
    await channel.request(ID, { path: '/health', headers: { 'X-Test': 'a\nurl = "http://elsewhere"' } });
    expect(calls[0].options.stdin.split('\n')).toHaveLength(5);
  });

  it('rejects a NUL character, which a curl config cannot carry', async () => {
    const { channel, calls } = channelWith(ok(http(200, '')));
    await expect(channel.request(ID, { path: '/health', body: 'a\0b' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toEqual([]);
  });

  it('says when nothing answers, with the curl exit code', async () => {
    const { channel } = channelWith({ code: 7, stdout: '', stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 27600\n' });
    await expect(channel.request(ID, { path: '/health' })).rejects.toMatchObject({ code: 'space_server_unreachable', details: { curlExitCode: 7 } });
  });

  it('rejects an answer that is not HTTP', async () => {
    const { channel } = channelWith(ok('garbage'));
    await expect(channel.request(ID, { path: '/health' })).rejects.toMatchObject({ code: 'space_server_answer_unreadable' });
  });

  it('takes header names such as __proto__ and constructor as plain names', async () => {
    const { channel } = channelWith(ok(http(200, '{}', ['__proto__: polluted', 'constructor: x', 'toString: y', 'no colon here', ': empty name'])));
    const answer = await channel.request(ID, { path: '/health' });

    expect(answer.headers.__proto__).toEqual(['polluted']);
    expect(answer.headers.constructor).toEqual(['x']);
    expect(answer.headers.tostring).toEqual(['y']);
    expect(Object.keys(answer.headers)).toEqual(['content-type', '__proto__', 'constructor', 'tostring']);
    expect({}.polluted).toBeUndefined();
  });

  it('parses tens of thousands of repeated header lines in linear time, and refuses them by the cap', async () => {
    // The old code copied an array per line and blocked the event loop for seconds on an answer like this.
    // Now the cap on the header block refuses it before any line is looked at.
    const lines = Array.from({ length: 50_000 }, () => 'x: 1');
    const { channel } = channelWith(ok(http(200, '{}', lines)));

    const started = performance.now();
    const error = await channel.request(ID, { path: '/health' }).catch((caught) => caught);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('space_server_answer_unreadable');
  });

  it('accepts 200 header lines, also of one repeated name, and refuses 201', async () => {
    const accepted = channelWith(ok(http(200, '{}', Array.from({ length: 199 }, (unused, index) => `Set-Cookie: c${index}=1`))));
    const answer = await accepted.channel.request(ID, { path: '/health' });
    expect(answer.headers['set-cookie']).toHaveLength(199);
    expect(answer.headers['set-cookie'][198]).toBe('c198=1');

    const refused = channelWith(ok(http(200, '{}', Array.from({ length: 200 }, () => 'x: 1'))));
    await expect(refused.channel.request(ID, { path: '/health' })).rejects.toMatchObject({ code: 'space_server_answer_unreadable', message: expect.stringContaining('200 header lines') });
  });

  it('refuses a header block of more than 64 KiB before it looks at its lines', async () => {
    const { channel } = channelWith(ok(http(200, '{}', [`x: ${'a'.repeat(70_000)}`])));
    await expect(channel.request(ID, { path: '/health' })).rejects.toMatchObject({ code: 'space_server_answer_unreadable', message: expect.stringContaining('65536 bytes of headers') });
  });

  it('maps a request whose exec timed out or was killed to "unreachable", never to an interrupted Docker step', async () => {
    for (const code of ['command_timeout', 'command_killed']) {
      const { channel } = channelWith(Object.assign(new Error('docker exec did not finish'), { code }));
      const error = await channel.request(ID, { path: '/health' }).catch((caught) => caught);
      expect(error).toBeInstanceOf(SpaceError);
      expect(error.code).toBe('space_server_unreachable');
    }
  });

  it('maps more output than the host accepts to an unreadable answer, never to an interrupted Docker step', async () => {
    const tooLarge = Object.assign(new Error('docker exec printed more than 4194304 bytes and was stopped'), { code: 'command_output_too_large' });
    const { channel } = channelWith(tooLarge);

    const error = await channel.request(ID, { path: '/health' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('space_server_answer_unreadable');
  });

  it('cuts the text from inside the space in an error message to 2,000 characters', async () => {
    const { channel } = channelWith({ code: 22, stdout: '', stderr: 'x'.repeat(50_000) });
    const error = await channel.request(ID, { path: '/health' }).catch((caught) => caught);
    expect(error.message.length).toBeLessThan(2_100);

    const failing = channelWith({ code: 1, stdout: '', stderr: 'y'.repeat(50_000) });
    const setupError = await failing.channel.writeToken(ID, 'x').catch((caught) => caught);
    expect(setupError.message.length).toBeLessThan(2_100);
  });
});

describe('space server channel: waitUntilReady', () => {
  const refused = { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };

  it('waits through "nothing listens yet" and "OpenCode not ready", then resolves', async () => {
    const { channel, calls, waits } = channelWith(refused, refused, ok(http(200, '{"isOpenCodeReady":false}')), ok(http(200, '{"isOpenCodeReady":true}')));
    await channel.waitUntilReady(ID);

    expect(calls).toHaveLength(4);
    expect(waits()).toBe(3);
  });

  it('gives up at the deadline and says what it saw last', async () => {
    const { channel, calls } = channelWith(ok(http(200, '{"isOpenCodeReady":false}')));

    const error = await channel.waitUntilReady(ID).catch((caught) => caught);
    expect(error.code).toBe('space_server_not_ready');
    expect(error.message).toMatch(/within 120 seconds \(the answer does not report OpenCode ready\)/);
    expect(calls).toHaveLength(240);
  });

  it('asks /health with a short time limit, so a listener that never answers costs little', async () => {
    const { channel, calls } = channelWith(ok(http(200, '{"isOpenCodeReady":true}')));
    await channel.waitUntilReady(ID);

    expect(calls[0].argv).toEqual(['/usr/bin/curl', '--disable', '--noproxy', '*', '--silent', '--show-error', '--include', '--max-time', '3', '--config', '-']);
    expect(calls[0].options.timeoutMs).toBe(13_000);
  });

  it('ends at the wall-clock deadline when something on the port accepts and never answers', async () => {
    // Every attempt runs into the time limit of curl: three seconds each, exit code 28.
    const { channel, calls } = channelTaking(3, { code: 28, stdout: '', stderr: 'curl: (28) Operation timed out' });

    const error = await channel.waitUntilReady(ID).catch((caught) => caught);
    expect(error.code).toBe('space_server_not_ready');
    // 120 seconds of deadline, in steps of 3.5 seconds. The old count of 240 attempts would have been 14 minutes here.
    expect(calls.length).toBeLessThanOrEqual(35);
    expect(error.message).toMatch(/within 12\d seconds/);
  });

  it('still ends when the clock of the caller stands still', async () => {
    const calls = [];
    const exec = async (spaceId, argv) => { calls.push(argv); return { code: 7, stdout: '', stderr: '' }; };
    const channel = createSpaceServerChannel({ exec, wait: async () => {}, now: () => 5 });

    await expect(channel.waitUntilReady(ID)).rejects.toMatchObject({ code: 'space_server_not_ready' });
    expect(calls).toHaveLength(1_000);
  });

  it.each([
    ['a body of null', ok(http(200, 'null'))],
    ['a body that is a number', ok(http(200, '5'))],
    ['a body that is not JSON', ok(http(200, '<html>'))],
    ['an empty body', ok(http(200, ''))],
    ['a ready answer with another status', ok(http(503, '{"isOpenCodeReady":true}'))],
    ['a truthy value that is not true', ok(http(200, '{"isOpenCodeReady":"yes"}'))],
    // Ready, but far larger than a health answer. The host does not spend time parsing it.
    ['a ready body of more than 64 KiB', ok(http(200, `{"isOpenCodeReady":true,"padding":"${'x'.repeat(70 * 1024)}"}`))],
    // Measured with curl 7.88.1 against a listener that answers `hello`: exit code 1, the code that a failed `docker exec` uses too.
    ['a listener that does not speak HTTP', { code: 1, stdout: '', stderr: 'curl: (1) Received HTTP/0.9 when not allowed\n' }],
    ['a request whose exec timed out', Object.assign(new Error('docker exec did not finish'), { code: 'command_timeout' })],
    ['more header lines than the host parses', ok(http(200, '{"isOpenCodeReady":true}', Array.from({ length: 5_000 }, () => 'x: 1')))],
    ['a header named __proto__', ok(http(200, '{}', ['__proto__: x']))],
    ['curl exit code 56, a reset connection', { code: 56, stdout: '', stderr: 'curl: (56) Recv failure' }],
    ['curl exit code 8, a weird server reply', { code: 8, stdout: '', stderr: 'curl: (8) Weird server reply' }],
    ['more output than the host accepts', Object.assign(new Error('too much'), { code: 'command_output_too_large' })],
  ])('counts %s from inside as "not ready yet", and throws nothing but a SpaceError at the end', async (title, hostile) => {
    const { channel, calls } = channelWith(hostile);

    const error = await channel.waitUntilReady(ID).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('space_server_not_ready');
    expect(calls.length).toBeGreaterThan(1);
  });

  it('becomes ready after hostile answers, when the real server takes the port', async () => {
    const { channel } = channelWith(ok(http(200, 'null')), { code: 1, stdout: '', stderr: 'curl: (1) Received HTTP/0.9 when not allowed' }, { code: 52, stdout: '', stderr: '' }, ok(http(200, '{"isOpenCodeReady":true}')));
    await channel.waitUntilReady(ID);
  });

  it('stops at once when the container is gone, instead of waiting for the whole time', async () => {
    const { channel, calls } = channelWith({ code: 1, stdout: '', stderr: 'Error response from daemon: container abc is not running' });

    await expect(channel.waitUntilReady(ID)).rejects.toMatchObject({ code: 'space_server_unreachable', message: expect.stringContaining('is not running') });
    expect(calls).toHaveLength(1);
  });

  it.each([1, 125, 126, 127])('stops at once for exit code %i without a curl message, because then docker exec itself failed', async (code) => {
    const { channel, calls } = channelWith({ code, stdout: '', stderr: 'OCI runtime exec failed: exec failed: unable to start container process' });
    await expect(channel.waitUntilReady(ID)).rejects.toMatchObject({ code: 'space_server_unreachable', details: { execFailed: true } });
    expect(calls).toHaveLength(1);
  });

  it('lets a failure of the place through', async () => {
    const failure = Object.assign(new Error('spawn docker ENOENT'), { code: 'command_spawn_failed' });
    const { channel } = channelWith(failure);
    await expect(channel.waitUntilReady(ID)).rejects.toBe(failure);
  });
});
