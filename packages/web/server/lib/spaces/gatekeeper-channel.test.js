import { describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { GATEKEEPER_PROGRAM, createGatekeeperChannel } from './gatekeeper-channel.js';

const ID = 'a1b2c3d4e5f6';
const SECRET = 'sk-the-real-key-the-space-never-sees';
const http = (status, body) => `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${body}`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

/**
 * A channel on a recording `exec`. `answers` are returned in turn, the last one repeats.
 * Nothing sleeps: the clock moves by the pause in `wait`.
 */
const channelWith = (...answers) => {
  const calls = [];
  let clock = 1_000_000;
  const exec = async (spaceId, argv, options) => {
    calls.push({ spaceId, argv, options });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const wait = async (milliseconds) => { clock += milliseconds; };
  return { channel: createGatekeeperChannel({ exec, wait, now: () => clock }), calls };
};

describe('gatekeeper channel: the program', () => {
  it('is the file beside this module, and it is one self-contained script', () => {
    expect(GATEKEEPER_PROGRAM).toContain("require('node:net')");
    expect(GATEKEEPER_PROGRAM.length).toBeGreaterThan(2_000);
  });

  it('travels on stdin into the tmpfs, through a temporary name, and is in no argument', async () => {
    const { channel, calls } = channelWith(ok());
    await channel.writeProgram(ID);

    expect(calls).toEqual([{
      spaceId: ID,
      argv: [
        '/bin/sh', '-c',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; mkdir -p /tmp/openchamber-gatekeeper && cat > /tmp/openchamber-gatekeeper/gatekeeper.cjs.new && mv /tmp/openchamber-gatekeeper/gatekeeper.cjs.new /tmp/openchamber-gatekeeper/gatekeeper.cjs',
      ],
      options: { stdin: GATEKEEPER_PROGRAM, target: 'gatekeeper' },
    }]);
  });

  it('says what failed inside the gatekeeper', async () => {
    const { channel } = channelWith({ code: 1, stdout: '', stderr: 'sh: 1: cannot create: No space left on device\n' });
    await expect(channel.writeProgram(ID)).rejects.toMatchObject({ code: 'gatekeeper_setup_failed', message: expect.stringContaining('No space left on device') });
  });
});

describe('gatekeeper channel: control requests', () => {
  it('reaches the control listener on the gatekeeper loopback, with --disable and --noproxy first', async () => {
    const { channel, calls } = channelWith(ok(http(200, '{"ok":true}')));
    await channel.setNetwork(ID, { mode: 'allowlist', domains: ['api.anthropic.com'] });

    expect(calls[0].options.target).toBe('gatekeeper');
    expect(calls[0].argv.slice(0, 4)).toEqual(['/usr/bin/curl', '--disable', '--noproxy', '*']);
    expect(calls[0].options.stdin.split('\n')).toEqual([
      'url = "http://127.0.0.1:9099/network"',
      'request = "POST"',
      'header = "Expect:"',
      'header = "Content-Type: application/json"',
      'data-raw = "{\\"mode\\":\\"allowlist\\",\\"domains\\":[\\"api.anthropic.com\\"]}"',
      '',
    ]);
  });

  it('keeps a grant\'s secret out of every argument list, on the host and inside', async () => {
    const { channel, calls } = channelWith(ok(http(200, '{"ok":true}')));
    await channel.addGrant(ID, { id: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', secret: SECRET });

    expect(calls[0].argv.join(' ')).not.toContain(SECRET);
    expect(calls[0].options.stdin).toContain(SECRET);
  });

  it('reports a refusal from the control channel, with what it said', async () => {
    const { channel } = channelWith(ok(http(400, '{"error":"mode is \\"allowlist\\" or \\"open\\""}')));
    await expect(channel.setNetwork(ID, { mode: 'everything', domains: [] })).rejects.toMatchObject({
      code: 'gatekeeper_refused',
      details: { status: 400 },
      message: expect.stringContaining('allowlist'),
    });
  });

  it('says when nothing answers, with the curl exit code', async () => {
    const { channel } = channelWith({ code: 7, stdout: '', stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 9099\n' });
    await expect(channel.readJournal(ID)).rejects.toMatchObject({ code: 'gatekeeper_unreachable', details: { curlExitCode: 7 } });
  });

  it.each([
    ['an answer that is not HTTP', ok('garbage')],
    ['more output than the host accepts', Object.assign(new Error('too much'), { code: 'command_output_too_large' })],
  ])('rejects %s as unreadable', async (title, answer) => {
    const { channel } = channelWith(answer);
    const error = await channel.readJournal(ID).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('gatekeeper_answer_unreadable');
  });

  it('maps an exec that timed out to "unreachable", never to an interrupted Docker step', async () => {
    for (const code of ['command_timeout', 'command_killed']) {
      const { channel } = channelWith(Object.assign(new Error('docker exec did not finish'), { code }));
      const error = await channel.readJournal(ID).catch((caught) => caught);
      expect(error.code).toBe('gatekeeper_unreachable');
      expect(error.details.execFailed).toBe(false);
    }
  });

  it('lets a failure of the place through', async () => {
    const failure = Object.assign(new Error('spawn docker ENOENT'), { code: 'command_spawn_failed' });
    const { channel } = channelWith(failure);
    await expect(channel.readJournal(ID)).rejects.toBe(failure);
  });
});

describe('gatekeeper channel: journal', () => {
  const record = { at: '2026-09-20T10:00:00.000Z', listener: 'corridor', host: 'api.anthropic.com', port: 443, decision: 'allow' };

  it('reads the records, how many the ring buffer dropped, and since when the gatekeeper records', async () => {
    const { channel } = channelWith(ok(http(200, JSON.stringify({ records: [record], dropped: 12, since: '2026-09-20T09:00:00.000Z' }))));
    expect(await channel.readJournal(ID)).toEqual({ records: [record], dropped: 12, since: '2026-09-20T09:00:00.000Z' });
  });

  it('leaves "since" empty for a gatekeeper that does not say, and never takes an object for it', async () => {
    const { channel } = channelWith(ok(http(200, JSON.stringify({ records: [], dropped: 0, since: { at: 1 } }))));
    expect(await channel.readJournal(ID)).toEqual({ records: [], dropped: 0, since: '' });
  });

  it('keeps the five fields of a record and nothing else the gatekeeper sends', async () => {
    const hostile = { ...record, path: '/v1/messages?key=leak', body: 'a body', secret: SECRET, extra: { deep: true } };
    const { channel } = channelWith(ok(http(200, JSON.stringify({ records: [hostile], dropped: 0 }))));

    const journal = await channel.readJournal(ID);
    expect(Object.keys(journal.records[0])).toEqual(['at', 'listener', 'host', 'port', 'decision']);
    expect(JSON.stringify(journal)).not.toContain(SECRET);
  });

  it('caps the records it reads, and the length of every field', async () => {
    // The gatekeeper keeps 500 records, so more than a thousand means something inside is wrong.
    const many = Array.from({ length: 2_000 }, () => ({ ...record, host: 'x'.repeat(400) }));
    const { channel } = channelWith(ok(http(200, JSON.stringify({ records: many, dropped: -1 }))));

    const journal = await channel.readJournal(ID);
    expect(journal.records).toHaveLength(1_000);
    expect(journal.records[0].host).toHaveLength(256);
    expect(journal.dropped).toBe(0);
  });

  it('refuses a journal larger than the host reads, instead of spending the time on it', async () => {
    const { channel } = channelWith(ok(http(200, JSON.stringify({ records: [{ ...record, host: 'x'.repeat(2 * 1024 * 1024) }] }))));
    await expect(channel.readJournal(ID)).rejects.toMatchObject({ code: 'gatekeeper_answer_unreadable' });
  });

  it.each([
    ['a body that is not JSON', '<html>'],
    ['a journal without records', '{"dropped":0}'],
    ['records that are not a list', '{"records":"none"}'],
    ['null', 'null'],
  ])('rejects %s instead of answering an empty journal', async (title, body) => {
    const { channel } = channelWith(ok(http(200, body)));
    await expect(channel.readJournal(ID)).rejects.toMatchObject({ code: 'gatekeeper_answer_unreadable' });
  });

  it('turns a record of another shape into empty fields, and never throws', async () => {
    const { channel } = channelWith(ok(http(200, JSON.stringify({ records: [null, 'text', { port: 'many' }] }))));
    expect(await channel.readJournal(ID)).toEqual({
      records: [
        { at: '', listener: '', host: '', port: 0, decision: '' },
        { at: '', listener: '', host: '', port: 0, decision: '' },
        { at: '', listener: '', host: '', port: 0, decision: '' },
      ],
      dropped: 0,
      since: '',
    });
  });
});

describe('gatekeeper channel: waitUntilReady', () => {
  const refused = { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };

  it('waits through "nothing listens yet" and resolves when the control channel answers', async () => {
    const { channel, calls } = channelWith(refused, refused, ok(http(200, '{"ready":true}')));
    await channel.waitUntilReady(ID);
    expect(calls).toHaveLength(3);
  });

  it('gives up at the deadline and says what it saw last', async () => {
    const { channel } = channelWith(refused);
    const error = await channel.waitUntilReady(ID).catch((caught) => caught);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('gatekeeper_not_ready');
    expect(error.message).toMatch(/within 60 seconds \(.*Failed to connect/);
  });

  it.each([
    ['a listener that does not speak HTTP', { code: 1, stdout: '', stderr: 'curl: (1) Received HTTP/0.9 when not allowed\n' }],
    ['an answer that is not HTTP', ok('garbage')],
    ['a 503 from the control channel', ok(http(503, '{}'))],
    ['an exec that timed out', Object.assign(new Error('docker exec did not finish'), { code: 'command_timeout' })],
  ])('counts %s as "not ready yet"', async (title, hostile) => {
    const { channel, calls } = channelWith(hostile);
    await expect(channel.waitUntilReady(ID)).rejects.toMatchObject({ code: 'gatekeeper_not_ready' });
    expect(calls.length).toBeGreaterThan(1);
  });

  it('stops at once when the container is gone', async () => {
    const { channel, calls } = channelWith({ code: 1, stdout: '', stderr: 'Error response from daemon: container abc is not running' });
    await expect(channel.waitUntilReady(ID)).rejects.toMatchObject({ code: 'gatekeeper_unreachable', details: { execFailed: true } });
    expect(calls).toHaveLength(1);
  });

  it('asks with a short time limit, so a listener that never answers costs little', async () => {
    const { channel, calls } = channelWith(ok(http(200, '{"ready":true}')));
    await channel.waitUntilReady(ID);
    expect(calls[0].argv).toContain('3');
    expect(calls[0].options.timeoutMs).toBe(13_000);
  });
});
