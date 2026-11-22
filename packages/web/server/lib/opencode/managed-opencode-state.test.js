import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearManagedOpenCodeState,
  createLaunchFingerprint,
  decideManagedOpenCodeLaunch,
  hashLaunchSecret,
  MANAGED_OPENCODE_LOG_READ_MAX_BYTES,
  readDrainingOpenCodeRecords,
  readLogSince,
  readLogTail,
  readManagedOpenCodeState,
  resolveManagedOpenCodePaths,
  rotateManagedLogIfOversized,
  writeDrainingOpenCodeRecords,
  writeManagedOpenCodeState,
} from './managed-opencode-state.js';

const serveArgs = ['serve', '--hostname', '127.0.0.1'];
const isWindows = process.platform === 'win32';

const validState = {
  pid: 4242,
  port: 45678,
  binary: '/usr/bin/opencode',
  fingerprint: 'abc123',
  password: 'secret-password',
  agentToolToken: null,
  startedAt: '2026-01-01T00:00:00.000Z',
};

const adoptable = {
  state: { ...validState, args: serveArgs, version: 1 },
  ownsPid: true,
  binary: '/usr/bin/opencode',
  args: serveArgs,
  fingerprint: 'abc123',
  port: 45678,
  healthy: true,
};

const readInChild = (reader, filePath) => {
  const moduleUrl = new URL('./managed-opencode-state.js', import.meta.url).href;
  const script = `import { ${reader} } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(${reader}(${JSON.stringify(filePath)})));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
};

describe('decideManagedOpenCodeLaunch', () => {
  it('starts when there is no saved state', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, state: null })).toEqual({ action: 'start', reason: 'no-state' });
  });

  it('starts without signalling when the recorded pid is not verified as OpenCode', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, ownsPid: false })).toEqual({ action: 'start', reason: 'recorded-process-gone' });
  });

  it('hands off when the binary changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, binary: '/opt/new/opencode' })).toEqual({ action: 'handoff', reason: 'binary-changed' });
  });

  it('hands off when the arguments changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, args: ['serve', '--hostname', '0.0.0.0'] })).toEqual({ action: 'handoff', reason: 'args-changed' });
  });

  it('adopts a state recorded before arguments were stored', () => {
    const legacyState = { ...adoptable.state };
    delete legacyState.args;
    expect(decideManagedOpenCodeLaunch({ ...adoptable, state: legacyState })).toEqual({ action: 'adopt', reason: 'matches-state' });
  });

  it('hands off when the port changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, port: 45679 })).toEqual({ action: 'handoff', reason: 'port-changed' });
  });

  it('hands off when the launch fingerprint changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, fingerprint: 'other' })).toEqual({ action: 'handoff', reason: 'launch-config-changed' });
  });

  it('replaces an unhealthy recorded OpenCode instead of handing off to it', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, binary: '/opt/new/opencode', healthy: false })).toEqual({ action: 'replace', reason: 'unhealthy' });
  });

  it('adopts when pid, binary, port, fingerprint and health all match', () => {
    expect(decideManagedOpenCodeLaunch(adoptable)).toEqual({ action: 'adopt', reason: 'matches-state' });
  });
});

describe('managed OpenCode state file', () => {
  let root;

  it('keeps draining records when the current state is cleared', () => {
    const drainingPath = path.join(root, 'draining.json');
    const record = { pid: 7001, port: 45001, binary: '/usr/bin/opencode', drainStartedAt: 1700000000000 };
    writeDrainingOpenCodeRecords(drainingPath, [record]);
    writeManagedOpenCodeState(resolveManagedOpenCodePaths(root).statePath, validState);
    clearManagedOpenCodeState(resolveManagedOpenCodePaths(root).statePath);
    expect(readDrainingOpenCodeRecords(drainingPath)).toEqual([record]);
  });

  it('ignores malformed draining records and removes the file once nothing drains', () => {
    const drainingPath = path.join(root, 'draining.json');
    fs.writeFileSync(drainingPath, JSON.stringify({ version: 1, draining: [{ pid: -1 }, { pid: 7002, port: 45002, binary: '/usr/bin/opencode', drainStartedAt: 1 }] }));
    expect(readDrainingOpenCodeRecords(drainingPath).map((record) => record.pid)).toEqual([7002]);
    writeDrainingOpenCodeRecords(drainingPath, []);
    expect(fs.existsSync(drainingPath)).toBe(false);
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-opencode-state-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips the saved state with owner-only permissions', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    writeManagedOpenCodeState(statePath, validState);

    expect(readManagedOpenCodeState(statePath)).toEqual({ version: 1, ...validState });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it('accepts a string agent-tool token', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    writeManagedOpenCodeState(statePath, { ...validState, agentToolToken: 'token-value' });

    expect(readManagedOpenCodeState(statePath)?.agentToolToken).toBe('token-value');
  });

  it('returns null for a missing file', () => {
    expect(readManagedOpenCodeState(path.join(root, 'missing.json'))).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{not json');

    expect(readManagedOpenCodeState(statePath)).toBeNull();
  });

  it('returns null for an oversized state file', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, ...validState, password: 'p'.repeat(64 * 1024) }));

    expect(readManagedOpenCodeState(statePath)).toBeNull();
  });

  it.skipIf(isWindows)('returns null for a FIFO state file without blocking', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    execFileSync('mkfifo', [statePath]);

    expect(readInChild('readManagedOpenCodeState', statePath)).toBe('null');
  });

  it('returns an empty list for a missing or malformed draining file', () => {
    const drainingPath = path.join(root, 'draining.json');
    expect(readDrainingOpenCodeRecords(drainingPath)).toEqual([]);

    fs.writeFileSync(drainingPath, '{not json');
    expect(readDrainingOpenCodeRecords(drainingPath)).toEqual([]);
  });

  it('returns an empty list for an oversized draining file', () => {
    const drainingPath = path.join(root, 'draining.json');
    fs.writeFileSync(drainingPath, JSON.stringify({
      version: 1,
      draining: [{ pid: 7001, port: 45001, binary: 'b'.repeat(64 * 1024), drainStartedAt: 1700000000000 }],
    }));

    expect(readDrainingOpenCodeRecords(drainingPath)).toEqual([]);
  });

  it.skipIf(isWindows)('returns an empty list for a FIFO draining file without blocking', () => {
    const drainingPath = path.join(root, 'draining.json');
    execFileSync('mkfifo', [drainingPath]);

    expect(readInChild('readDrainingOpenCodeRecords', drainingPath)).toBe('[]');
  });

  it.each([
    ['an unknown version', { version: 2 }],
    ['a non-positive pid', { pid: 0 }],
    ['a non-integer port', { port: '45678' }],
    ['an empty binary', { binary: '' }],
    ['a missing fingerprint', { fingerprint: undefined }],
    ['an empty password', { password: '' }],
    ['a non-string agent token', { agentToolToken: 7 }],
  ])('returns null for a state file with %s', (_label, override) => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, ...validState, ...override }));

    expect(readManagedOpenCodeState(statePath)).toBeNull();
  });

  it('clears the state and tolerates a missing file', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    writeManagedOpenCodeState(statePath, validState);

    clearManagedOpenCodeState(statePath);
    clearManagedOpenCodeState(statePath);

    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('hashes launch secrets and treats a missing secret as empty', () => {
    expect(hashLaunchSecret('secret-password')).not.toContain('secret-password');
    expect(hashLaunchSecret(undefined)).toBe(hashLaunchSecret(''));
  });
});

describe('launch fingerprint', () => {
  it('is independent of key order', () => {
    expect(createLaunchFingerprint({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(createLaunchFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when a launch value changes', () => {
    expect(createLaunchFingerprint({ port: 45678 })).not.toBe(createLaunchFingerprint({ port: 45679 }));
  });
});

describe('managed OpenCode log cursor', () => {
  let root;
  let logPath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-opencode-log-'));
    logPath = path.join(root, 'opencode.log');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads only bytes written after the cursor and advances it', () => {
    fs.writeFileSync(logPath, 'first line\n');
    const first = readLogSince(logPath, 0);
    expect(first).toEqual({ text: 'first line\n', offset: 11 });

    fs.appendFileSync(logPath, 'second line\n');
    expect(readLogSince(logPath, first.offset)).toEqual({ text: 'second line\n', offset: 23 });
  });

  it('returns no text and keeps the cursor when nothing new was written', () => {
    fs.writeFileSync(logPath, 'line\n');
    expect(readLogSince(logPath, 5)).toEqual({ text: '', offset: 5 });
  });

  it('holds back a trailing incomplete UTF-8 sequence instead of corrupting it', () => {
    // Oracle: the unsplit control string. A multi-byte character split across
    // two polls at any byte position must arrive intact in the accumulated
    // output, and the first poll's offset must stop before the partial bytes.
    for (const char of ['\u00e9', '\u20ac', '\u{1f600}']) {
      const control = `diag boot ${char} ready`;
      const bytes = Buffer.from(control, 'utf8');
      const charStart = Buffer.from('diag boot ', 'utf8').length;
      const charLength = Buffer.from(char, 'utf8').length;
      for (let split = 1; split < charLength; split++) {
        fs.writeFileSync(logPath, bytes.subarray(0, charStart + split));
        const first = readLogSince(logPath, 0);
        expect(first).toEqual({ text: 'diag boot ', offset: charStart });
        fs.writeFileSync(logPath, bytes);
        const second = readLogSince(logPath, first.offset);
        expect(first.text + second.text).toBe(control);
        expect(second.offset).toBe(bytes.length);
      }
    }
  });

  it('still decodes invalid trailing bytes instead of holding them back forever', () => {
    fs.writeFileSync(logPath, Buffer.from([0x61, 0x80]));
    const result = readLogSince(logPath, 0);
    expect(result.offset).toBe(2);
    expect(result.text).toBe('a\ufffd');
  });

  it('delivers never-valid UTF-8 lead bytes instead of holding them back forever (#1790)', () => {
    // Oracle: Buffer.prototype.toString('utf8') is the reference decoder. Every
    // byte that is not a valid lead (overlong 0xC0/0xC1, never-valid 0xF5-0xFF)
    // must be delivered in the same poll it was written, with the offset
    // advanced past it — no later byte can complete it, so holding it back
    // stalls the cursor for good.
    for (const lead of [0xc0, 0xc1, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]) {
      const bytes = Buffer.from([0x61, lead]);
      fs.writeFileSync(logPath, bytes);
      const result = readLogSince(logPath, 0);
      expect(result.offset).toBe(bytes.length);
      expect(result.text).toBe(bytes.toString('utf8'));
      expect(result.text).toBe('a\ufffd');
    }
  });

  it('delivers a never-valid lead byte followed by continuation bytes in one poll (#1790)', () => {
    // The held-back shape the bug produced: the lead byte plus the continuation
    // bytes that follow it. None of these can ever form a character.
    fs.writeFileSync(logPath, Buffer.from([0x61, 0xc0, 0x80, 0x80]));
    const result = readLogSince(logPath, 0);
    expect(result.offset).toBe(4);
    expect(result.text).toBe('a\ufffd\ufffd\ufffd');
  });

  it('returns empty text for a missing log', () => {
    expect(readLogSince(logPath, 0)).toEqual({ text: '', offset: 0 });
  });

  it.skipIf(isWindows)('treats a FIFO at the log path as no output instead of blocking (#1794)', () => {
    // The readiness drain calls this synchronously: a plain open would block
    // the whole server event loop on the FIFO forever. The call returning at
    // all is the assertion; the result must be the no-output answer.
    execFileSync('mkfifo', [logPath]);
    expect(readLogSince(logPath, 0)).toEqual({ text: '', offset: 0 });
    expect(readLogSince(logPath, 7)).toEqual({ text: '', offset: 7 });
  });

  it('caps one call at the per-call byte limit and leaves the rest for later polls (#1794)', () => {
    const total = MANAGED_OPENCODE_LOG_READ_MAX_BYTES + 100;
    fs.writeFileSync(logPath, 'x'.repeat(total));
    const first = readLogSince(logPath, 0);
    expect(first.text.length).toBe(MANAGED_OPENCODE_LOG_READ_MAX_BYTES);
    expect(first.offset).toBe(MANAGED_OPENCODE_LOG_READ_MAX_BYTES);
    const second = readLogSince(logPath, first.offset);
    expect(second).toEqual({ text: 'x'.repeat(100), offset: total });
  });

  it('returns the tail of the log from the cursor, capped at maxBytes', () => {
    fs.writeFileSync(logPath, 'abcdefghij');
    expect(readLogTail(logPath, 0, 4)).toBe('ghij');
    expect(readLogTail(logPath, 8, 4)).toBe('ij');
  });

  it('returns an empty tail for a missing log', () => {
    expect(readLogTail(logPath, 0, 16)).toBe('');
  });

  it('aligns the tail start to a UTF-8 boundary when the cut lands inside a character (#2033)', () => {
    // 100 ASCII bytes, the 3-byte euro sign, then 62 ASCII bytes: a
    // 64-byte tail starts on the euro sign's second byte.
    fs.writeFileSync(logPath, 'a'.repeat(100) + String.fromCharCode(0x20ac) + 'b'.repeat(62));
    const tail = readLogTail(logPath, 0, 64);
    expect(tail).toBe('b'.repeat(62));
    expect(tail).not.toContain(String.fromCharCode(0xfffd));
  });

  it('keeps a character whole when the tail start lands exactly on its lead byte (#2033)', () => {
    fs.writeFileSync(logPath, 'a'.repeat(100) + String.fromCharCode(0x20ac) + 'b'.repeat(61));
    expect(readLogTail(logPath, 0, 64)).toBe(String.fromCharCode(0x20ac) + 'b'.repeat(61));
  });
});

describe('rotateManagedLogIfOversized', () => {
  let root;
  let logPath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-opencode-rotate-'));
    logPath = path.join(root, 'opencode.log');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('renames an oversized log to the single retained generation', () => {
    fs.writeFileSync(logPath, 'old log contents');
    expect(rotateManagedLogIfOversized(logPath, 4)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('old log contents');
  });

  it('replaces the previous generation on the next rotation', () => {
    fs.writeFileSync(logPath, 'first generation');
    expect(rotateManagedLogIfOversized(logPath, 4)).toBe(true);
    fs.writeFileSync(logPath, 'second generation');
    expect(rotateManagedLogIfOversized(logPath, 4)).toBe(true);
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('second generation');
  });

  it('leaves a log at or under the cap untouched', () => {
    fs.writeFileSync(logPath, 'tiny');
    expect(rotateManagedLogIfOversized(logPath, 4)).toBe(false);
    expect(fs.readFileSync(logPath, 'utf8')).toBe('tiny');
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('keeps the tail readable after rotation and new writes', () => {
    fs.writeFileSync(logPath, 'abcdefghij');
    expect(rotateManagedLogIfOversized(logPath, 4)).toBe(true);
    fs.writeFileSync(logPath, 'new tail');
    expect(readLogTail(logPath, 0, 4)).toBe('tail');
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('abcdefghij');
  });

  it('is a no-op for a missing log instead of throwing', () => {
    expect(rotateManagedLogIfOversized(logPath, 4)).toBe(false);
  });
});
