import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceArtifactCache, applyWorkspaceArtifact, parseWorkspaceArtifact } from './structured-artifact.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileEntry = (filePath, content, mode = 0o644, binary = false) => ({ path: filePath, type: 'file', mode, size: content.length, hash: hash(content), binary });
const blob = (content) => ({ hash: hash(content), size: content.length, contentBase64: content.toString('base64') });
const directoryEntry = (filePath, mode = 0o755) => ({ path: filePath, type: 'directory', mode });
const contextHash = hash('context');

function artifact(files, blobs, overrides = {}) {
  const value = {
    version: 1,
    id: crypto.randomUUID(),
    controlPlaneWorkspaceID: 'workspace-1',
    providerResourceID: 'resource-1',
    projectID: 'project-1',
    provider: 'docker',
    baselineGeneration: 'generation-1',
    targetDirectory: overrides.targetDirectory,
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    files,
    blobs,
    ...overrides,
  };
  delete value.integrityHash;
  value.integrityHash = hash(JSON.stringify(value));
  return value;
}

function operation(kind, oldEntry, nextEntry, extra = {}) {
  return {
    id: crypto.randomUUID(),
    kind,
    oldPath: oldEntry?.path,
    newPath: nextEntry?.path,
    binary: Boolean(oldEntry?.binary || nextEntry?.binary),
    oldMode: oldEntry?.mode,
    newMode: nextEntry?.mode,
    baselineHash: oldEntry?.hash,
    resultHash: nextEntry?.hash,
    baselineBlob: oldEntry?.type === 'file' ? oldEntry.hash : null,
    resultBlob: nextEntry?.type === 'file' ? nextEntry.hash : null,
    textHunks: [],
    old: oldEntry ?? null,
    next: nextEntry ?? null,
    ...extra,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-structured-'));
  const directory = path.join(root, 'project');
  fs.mkdirSync(directory);
  return {
    root,
    directory,
    transactionRoot: path.join(root, 'transactions'),
    lockRoot: path.join(root, 'locks'),
  };
}

function parse(value, directory) {
  return parseWorkspaceArtifact(value, {
    controlPlaneWorkspaceID: 'workspace-1',
    providerResourceID: 'resource-1',
    projectID: 'project-1',
    provider: 'docker',
    targetDirectory: directory,
  });
}

describe('structured workspace artifacts', () => {
  it.each([
    ['malformed', '{', /malformed/],
    ['expired', null, /expired/],
    ['mismatched identity', null, /authoritative workspace/],
  ])('rejects %s artifacts', (_name, raw, message) => {
    const { directory } = fixture();
    if (raw) expect(() => parseWorkspaceArtifact(raw, {})).toThrow(message);
    else {
      const content = Buffer.from('new');
      const entry = fileEntry('new.txt', content);
      const overrides = _name === 'expired'
        ? { targetDirectory: directory, expiresAt: new Date(Date.now() - 1).toISOString() }
        : { targetDirectory: directory, projectID: 'wrong-project' };
      const value = artifact([operation('add', null, entry)], [blob(content)], overrides);
      expect(() => parse(value, directory)).toThrow(message);
    }
  });

  it('rejects oversized entries and escaping symlinks', () => {
    const { directory } = fixture();
    const content = Buffer.from('x');
    const oversized = fileEntry('large.bin', content, 0o644, true);
    oversized.size = 16 * 1024 * 1024 + 1;
    const oversizedArtifact = artifact([operation('add', null, oversized)], [blob(content)], { targetDirectory: directory });
    expect(() => parse(oversizedArtifact, directory)).toThrow(/metadata is invalid/);

    const link = { path: 'link', type: 'symlink', mode: 0o755, target: '../outside', hash: hash(Buffer.from('../outside')) };
    const escapingArtifact = artifact([operation('add', null, link, { symlinkTarget: '../outside' })], [], { targetDirectory: directory });
    expect(() => parse(escapingArtifact, directory)).toThrow(/escaping symlink/);
  });

  it('rejects duplicate and ancestor operation paths, including directory trees', () => {
    const { directory } = fixture();
    const content = Buffer.from('content');
    const child = fileEntry('tree/child.txt', content);
    const files = [operation('add', null, directoryEntry('tree')), operation('add', null, child)];
    expect(() => parse(artifact(files, [blob(content)], { targetDirectory: directory }), directory)).toThrow(/overlapping operation paths/);

    const duplicate = [operation('add', null, fileEntry('same', content)), operation('add', null, fileEntry('same', content))];
    expect(() => parse(artifact(duplicate, [blob(content)], { targetDirectory: directory }), directory)).toThrow(/duplicate or overlapping/);

    const rename = operation('rename', fileEntry('parent', content), fileEntry('parent/child', content));
    expect(() => parse(artifact([rename], [blob(content)], { targetDirectory: directory }), directory)).toThrow(/operation paths overlap/);
  });

  it.each([
    ['without a trailing newline', Buffer.from('added'), ['added']],
    ['with a trailing newline', Buffer.from('added\n'), ['added', '']],
  ])('applies added text with exact bytes %s', async (_name, result, added) => {
    const data = fixture();
    const next = fileEntry('added.txt', result);
    const change = operation('add', null, next, {
      textHunks: [{ id: 'add-hunk', oldStart: 1, oldCount: 0, newStart: 1, newCount: added.length, removed: [], added, contextHash }],
    });
    const parsed = parse(artifact([change], [blob(result)], { targetDirectory: data.directory }), data.directory);
    await applyWorkspaceArtifact({ ...data, parsed, selections: [{ fileID: change.id, hunkIDs: ['add-hunk'] }], checkOnly: false });
    expect(fs.readFileSync(path.join(data.directory, 'added.txt'))).toEqual(result);
  });

  it('removes the final text line without creating a newline', async () => {
    const data = fixture();
    const before = Buffer.from('removed');
    const after = Buffer.alloc(0);
    fs.writeFileSync(path.join(data.directory, 'text.txt'), before);
    const change = operation('modify', fileEntry('text.txt', before), fileEntry('text.txt', after), {
      textHunks: [{ id: 'delete-hunk', oldStart: 1, oldCount: 1, newStart: 1, newCount: 0, removed: ['removed'], added: [], contextHash }],
    });
    const parsed = parse(artifact([change], [blob(before), blob(after)], { targetDirectory: data.directory }), data.directory);
    await applyWorkspaceArtifact({ ...data, parsed, selections: [{ fileID: change.id, hunkIDs: ['delete-hunk'] }], checkOnly: false });
    expect(fs.readFileSync(path.join(data.directory, 'text.txt'))).toEqual(after);
  });

  it('rejects malformed, overlapping, and semantically inconsistent hunks', () => {
    const { directory } = fixture();
    const before = Buffer.from('a\nb\nc');
    const after = Buffer.from('A\nB\nc');
    const oldEntry = fileEntry('text.txt', before);
    const nextEntry = fileEntry('text.txt', after);
    const valid = [
      { id: 'one', oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, removed: ['a', 'b'], added: ['A', 'B'], contextHash },
    ];
    const malformed = operation('modify', oldEntry, nextEntry, { textHunks: [{ ...valid[0], newCount: 1 }] });
    expect(() => parse(artifact([malformed], [blob(before), blob(after)], { targetDirectory: directory }), directory)).toThrow(/hunk is invalid/);
    const badContext = operation('modify', oldEntry, nextEntry, { textHunks: [{ ...valid[0], contextHash: 'invalid' }] });
    expect(() => parse(artifact([badContext], [blob(before), blob(after)], { targetDirectory: directory }), directory)).toThrow(/hunk is invalid/);

    const outOfBounds = operation('modify', oldEntry, nextEntry, { textHunks: [{ id: 'bounds', oldStart: 3, oldCount: 2, newStart: 3, newCount: 2, removed: ['c', 'missing'], added: ['c', 'missing'], contextHash }] });
    expect(() => parse(artifact([outOfBounds], [blob(before), blob(after)], { targetDirectory: directory }), directory)).toThrow(/out of bounds/);

    const overlapping = operation('modify', oldEntry, nextEntry, { textHunks: [
      valid[0],
      { id: 'two', oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, removed: ['b'], added: ['B'], contextHash },
    ] });
    expect(() => parse(artifact([overlapping], [blob(before), blob(after)], { targetDirectory: directory }), directory)).toThrow(/overlap or are out of order/);

    const inconsistent = operation('modify', oldEntry, nextEntry, { textHunks: [{ ...valid[0], added: ['A', 'wrong'] }] });
    expect(() => parse(artifact([inconsistent], [blob(before), blob(after)], { targetDirectory: directory }), directory)).toThrow(/content is inconsistent/);
  });

  it('rejects binary flags that disagree with entries or blob bytes', () => {
    const { directory } = fixture();
    const binary = Buffer.from([0, 1, 2]);
    const incorrectlyText = fileEntry('binary.dat', binary, 0o644, false);
    expect(() => parse(artifact([operation('add', null, incorrectlyText)], [blob(binary)], { targetDirectory: directory }), directory)).toThrow(/binary metadata is inconsistent/);

    const text = Buffer.from('text');
    const incorrectlyBinary = fileEntry('text.txt', text, 0o644, true);
    expect(() => parse(artifact([operation('add', null, incorrectlyBinary)], [blob(text)], { targetDirectory: directory }), directory)).toThrow(/binary metadata is inconsistent/);
  });

  it('applies non-Git text, binary, symlink, mode, rename, add, and delete operations', async () => {
    const data = fixture();
    const oldText = Buffer.from('old\n');
    const newText = Buffer.from('new\n');
    const binary = Buffer.from([0, 255, 1]);
    const modeContent = Buffer.from('#!/bin/sh\n');
    const renameContent = Buffer.from('rename\n');
    const deletedContent = Buffer.from('delete\n');
    fs.writeFileSync(path.join(data.directory, 'text.txt'), oldText);
    fs.writeFileSync(path.join(data.directory, 'mode.sh'), modeContent, { mode: 0o644 });
    fs.writeFileSync(path.join(data.directory, 'old-name'), renameContent);
    fs.writeFileSync(path.join(data.directory, 'delete.txt'), deletedContent);
    fs.symlinkSync('old-target', path.join(data.directory, 'link'));
    const linkMode = fs.lstatSync(path.join(data.directory, 'link')).mode & 0o7777;
    const oldLink = { path: 'link', type: 'symlink', mode: linkMode, target: 'old-target', hash: hash(Buffer.from('old-target')) };
    const newLink = { path: 'link', type: 'symlink', mode: linkMode, target: 'new-target', hash: hash(Buffer.from('new-target')) };
    const oldMode = fileEntry('mode.sh', modeContent, 0o644);
    const newMode = fileEntry('mode.sh', modeContent, 0o755);
    const oldRename = fileEntry('old-name', renameContent);
    const newRename = fileEntry('new-name', renameContent);
    const files = [
      operation('modify', fileEntry('text.txt', oldText), fileEntry('text.txt', newText)),
      operation('add', null, fileEntry('binary.bin', binary, 0o644, true)),
      operation('modify', oldLink, newLink, { symlinkTarget: 'new-target' }),
      operation('mode', oldMode, newMode),
      operation('rename', oldRename, newRename),
      operation('delete', fileEntry('delete.txt', deletedContent), null),
    ];
    const blobs = [oldText, newText, binary, modeContent, renameContent, deletedContent].map(blob);
    const parsed = parse(artifact(files, blobs, { targetDirectory: data.directory }), data.directory);
    const result = await applyWorkspaceArtifact({ ...data, parsed, selections: files.map((file) => ({ fileID: file.id })), checkOnly: false });
    expect(result.applied).toBe(true);
    expect(fs.readFileSync(path.join(data.directory, 'text.txt'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(data.directory, 'binary.bin'))).toEqual(binary);
    expect(fs.readlinkSync(path.join(data.directory, 'link'))).toBe('new-target');
    expect(fs.statSync(path.join(data.directory, 'mode.sh')).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(data.directory, 'old-name'))).toBe(false);
    expect(fs.readFileSync(path.join(data.directory, 'new-name'), 'utf8')).toBe('rename\n');
    expect(fs.existsSync(path.join(data.directory, 'delete.txt'))).toBe(false);
  });

  it('applies selected text hunks while preserving unselected changes', async () => {
    const data = fixture();
    const before = Buffer.from('one\ntwo\nthree\n');
    const after = Buffer.from('ONE\ntwo\nTHREE\n');
    fs.writeFileSync(path.join(data.directory, 'text.txt'), before);
    const hunks = [
      { id: 'hunk-1', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removed: ['one'], added: ['ONE'], contextHash: hash('a') },
      { id: 'hunk-2', oldStart: 3, oldCount: 1, newStart: 3, newCount: 1, removed: ['three'], added: ['THREE'], contextHash: hash('b') },
    ];
    const change = operation('modify', fileEntry('text.txt', before), fileEntry('text.txt', after), { textHunks: hunks });
    const parsed = parse(artifact([change], [blob(before), blob(after)], { targetDirectory: data.directory }), data.directory);
    await applyWorkspaceArtifact({ ...data, parsed, selections: [{ fileID: change.id, hunkIDs: ['hunk-1'] }], checkOnly: false });
    expect(fs.readFileSync(path.join(data.directory, 'text.txt'), 'utf8')).toBe('ONE\ntwo\nthree\n');
  });

  it('supports a dirty Git target without consulting Git and rejects baseline conflicts', async () => {
    const data = fixture();
    execFileSync('git', ['init', '--quiet'], { cwd: data.directory });
    const before = Buffer.from('old\n');
    const after = Buffer.from('new\n');
    fs.writeFileSync(path.join(data.directory, 'tracked.txt'), before);
    fs.writeFileSync(path.join(data.directory, 'dirty.txt'), 'unrelated dirty change\n');
    const change = operation('modify', fileEntry('tracked.txt', before), fileEntry('tracked.txt', after));
    const parsed = parse(artifact([change], [blob(before), blob(after)], { targetDirectory: data.directory }), data.directory);
    await applyWorkspaceArtifact({ ...data, parsed, selections: [{ fileID: change.id }], checkOnly: false });
    expect(fs.readFileSync(path.join(data.directory, 'dirty.txt'), 'utf8')).toBe('unrelated dirty change\n');

    const conflictData = fixture();
    fs.writeFileSync(path.join(conflictData.directory, 'tracked.txt'), 'concurrent\n');
    const conflictParsed = parse(artifact([change], [blob(before), blob(after)], { targetDirectory: conflictData.directory }), conflictData.directory);
    await expect(applyWorkspaceArtifact({ ...conflictData, parsed: conflictParsed, selections: [{ fileID: change.id }], checkOnly: false })).rejects.toThrow(/conflicts/);
    expect(fs.readFileSync(path.join(conflictData.directory, 'tracked.txt'), 'utf8')).toBe('concurrent\n');
  });

  it('rolls back a failed mutation and recovers an interrupted journal before dry-run', async () => {
    const data = fixture();
    const oldA = Buffer.from('old-a');
    const newA = Buffer.from('new-a');
    const oldB = Buffer.from('old-b');
    const newB = Buffer.from('new-b');
    fs.writeFileSync(path.join(data.directory, 'a'), oldA);
    fs.writeFileSync(path.join(data.directory, 'b'), oldB);
    const files = [operation('modify', fileEntry('a', oldA), fileEntry('a', newA)), operation('modify', fileEntry('b', oldB), fileEntry('b', newB))];
    const parsed = parse(artifact(files, [oldA, newA, oldB, newB].map(blob), { targetDirectory: data.directory }), data.directory);
    await expect(applyWorkspaceArtifact({ ...data, parsed, selections: files.map((file) => ({ fileID: file.id })), checkOnly: false, beforeReplace: ({ index }) => { if (index === 1) throw new Error('injected failure'); } })).rejects.toThrow('injected failure');
    expect(fs.readFileSync(path.join(data.directory, 'a'))).toEqual(oldA);
    expect(fs.readFileSync(path.join(data.directory, 'b'))).toEqual(oldB);

    const recovery = fixture();
    const canonicalDirectory = fs.realpathSync(recovery.directory);
    const operationDirectory = path.join(recovery.transactionRoot, hash(canonicalDirectory), 'txn-crashed');
    const backups = path.join(operationDirectory, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(recovery.directory, 'a'), newA);
    fs.writeFileSync(path.join(backups, '0'), oldA);
    fs.writeFileSync(path.join(operationDirectory, 'journal.json'), JSON.stringify({ version: 2, state: 'applying', directory: canonicalDirectory, backupDirectory: backups, records: [{ path: 'a', existed: true, backup: '0', touched: true, fingerprint: { type: 'file', mode: 0o644, size: oldA.length, hash: hash(oldA) }, finalFingerprint: { type: 'file', mode: 0o644, size: newA.length, hash: hash(newA) } }] }));
    const recoveryFile = operation('modify', fileEntry('a', oldA), fileEntry('a', newA));
    const recoveryParsed = parse(artifact([recoveryFile], [blob(oldA), blob(newA)], { targetDirectory: recovery.directory }), recovery.directory);
    await applyWorkspaceArtifact({ ...recovery, parsed: recoveryParsed, selections: [{ fileID: recoveryFile.id }], checkOnly: true });
    expect(fs.readFileSync(path.join(recovery.directory, 'a'))).toEqual(oldA);
  });

  it('rejects a baseline or parent-symlink race immediately before mutation', async () => {
    const data = fixture();
    const before = Buffer.from('before');
    const after = Buffer.from('after');
    fs.writeFileSync(path.join(data.directory, 'file'), before);
    const change = operation('modify', fileEntry('file', before), fileEntry('file', after));
    const parsed = parse(artifact([change], [blob(before), blob(after)], { targetDirectory: data.directory }), data.directory);
    await expect(applyWorkspaceArtifact({
      ...data,
      parsed,
      selections: [{ fileID: change.id }],
      checkOnly: false,
      beforeReplace: () => fs.writeFileSync(path.join(data.directory, 'file'), 'concurrent'),
    })).rejects.toThrow(/changed before replacement/);
    expect(fs.readFileSync(path.join(data.directory, 'file'), 'utf8')).toBe('concurrent');

    const symlinkData = fixture();
    const outside = path.join(symlinkData.root, 'outside');
    fs.mkdirSync(path.join(symlinkData.directory, 'parent'));
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(symlinkData.directory, 'parent/file'), before);
    const nested = operation('modify', fileEntry('parent/file', before), fileEntry('parent/file', after));
    const nestedParsed = parse(artifact([nested], [blob(before), blob(after)], { targetDirectory: symlinkData.directory }), symlinkData.directory);
    await expect(applyWorkspaceArtifact({
      ...symlinkData,
      parsed: nestedParsed,
      selections: [{ fileID: nested.id }],
      checkOnly: false,
      beforeReplace: () => { fs.rmSync(path.join(symlinkData.directory, 'parent'), { recursive: true }); fs.symlinkSync(outside, path.join(symlinkData.directory, 'parent')); },
    })).rejects.toThrow(/escapes through a symlink/);
    expect(fs.existsSync(path.join(outside, 'file'))).toBe(false);
  });

  it('rechecks expiry under the lock before mutation', async () => {
    const data = fixture();
    const content = Buffer.from('new');
    const change = operation('add', null, fileEntry('new', content));
    const parsed = parse(artifact([change], [blob(content)], { targetDirectory: data.directory, expiresAt: new Date(Date.now() + 20).toISOString() }), data.directory);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(applyWorkspaceArtifact({ ...data, parsed, selections: [{ fileID: change.id }], checkOnly: false })).rejects.toThrow(/expired/);
    expect(fs.existsSync(path.join(data.directory, 'new'))).toBe(false);
  });

  it('rolls back failed final verification and recovers a corrupt committed final state', async () => {
    const data = fixture();
    const before = Buffer.from('before');
    const after = Buffer.from('after');
    fs.writeFileSync(path.join(data.directory, 'file'), before);
    const change = operation('modify', fileEntry('file', before), fileEntry('file', after));
    const parsed = parse(artifact([change], [blob(before), blob(after)], { targetDirectory: data.directory }), data.directory);
    await expect(applyWorkspaceArtifact({
      ...data,
      parsed,
      selections: [{ fileID: change.id }],
      checkOnly: false,
      afterReplace: () => fs.writeFileSync(path.join(data.directory, 'file'), 'tampered'),
    })).rejects.toThrow(/final verification failed/);
    expect(fs.readFileSync(path.join(data.directory, 'file'))).toEqual(before);

    const recovery = fixture();
    const canonicalDirectory = fs.realpathSync(recovery.directory);
    const operationDirectory = path.join(recovery.transactionRoot, hash(canonicalDirectory), 'txn-committed');
    const backups = path.join(operationDirectory, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(recovery.directory, 'file'), 'corrupt');
    fs.writeFileSync(path.join(backups, '0'), before);
    const unrelatedTransaction = path.join(recovery.transactionRoot, hash('/unrelated/project'), 'txn-corrupt');
    fs.mkdirSync(unrelatedTransaction, { recursive: true });
    fs.writeFileSync(path.join(unrelatedTransaction, 'journal.json'), '{not-json');
    const mode = fs.statSync(path.join(recovery.directory, 'file')).mode & 0o7777;
    fs.writeFileSync(path.join(operationDirectory, 'journal.json'), JSON.stringify({ version: 2, state: 'committed', directory: canonicalDirectory, backupDirectory: backups, records: [{ path: 'file', existed: true, backup: '0', touched: true, fingerprint: { type: 'file', mode, size: before.length, hash: hash(before) }, finalFingerprint: { type: 'file', mode, size: after.length, hash: hash(after) } }] }));
    const recoveryChange = operation('modify', fileEntry('file', before, mode), fileEntry('file', after, mode));
    const recoveryParsed = parse(artifact([recoveryChange], [blob(before), blob(after)], { targetDirectory: recovery.directory }), recovery.directory);
    await applyWorkspaceArtifact({ ...recovery, parsed: recoveryParsed, selections: [{ fileID: recoveryChange.id }], checkOnly: true });
    expect(fs.readFileSync(path.join(recovery.directory, 'file'))).toEqual(before);
  });
});

describe('workspace artifact disk cache', () => {
  function cacheFixture(overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-artifact-cache-'));
    const storage = path.join(root, 'workspace-exports');
    let now = Date.now();
    const cache = new WorkspaceArtifactCache({ rootDirectory: storage, now: () => now, ...overrides });
    const directory = path.join(root, 'project');
    fs.mkdirSync(directory);
    const createParsed = (id = crypto.randomUUID()) => {
      const content = Buffer.from(`content-${id}`);
      const next = fileEntry(`${id}.txt`, content);
      return parse(artifact([operation('add', null, next)], [blob(content)], { id, targetDirectory: directory, expiresAt: new Date(now + 120_000).toISOString() }), directory);
    };
    return { cache, createParsed, root, storage, advance: (milliseconds) => { now += milliseconds; } };
  }

  it('stores artifacts with private permissions and removes them on delete', async () => {
    const data = cacheFixture();
    const parsed = data.createParsed('private');
    await data.cache.set(parsed);
    expect(fs.statSync(data.storage).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(data.storage);
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(data.storage, files[0])).mode & 0o777).toBe(0o600);
    expect((await data.cache.get('private')).serialized.toString('utf8')).toBe(parsed.serialized);
    await data.cache.delete('private');
    expect(fs.readdirSync(data.storage)).toEqual([]);
  });

  it('does not publish an artifact when its atomic rename fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-artifact-failed-write-'));
    const filesystem = new Proxy(fs.promises, {
      get(target, property) {
        if (property === 'rename') return async () => { throw new Error('injected rename failure'); };
        return Reflect.get(target, property, target);
      },
    });
    const data = cacheFixture({ rootDirectory: path.join(root, 'workspace-exports'), filesystem });
    await expect(data.cache.set(data.createParsed('failed'))).rejects.toThrow('injected rename failure');
    expect(fs.readdirSync(path.join(root, 'workspace-exports'))).toEqual([]);
    expect(await data.cache.get('failed')).toBeNull();
  });

  it('invalidates prior-process files when a new cache starts', async () => {
    const data = cacheFixture();
    await data.cache.set(data.createParsed('prior-process'));
    expect(fs.readdirSync(data.storage)).toHaveLength(1);
    const restarted = new WorkspaceArtifactCache({ rootDirectory: data.storage });
    expect(await restarted.get('prior-process')).toBeNull();
    expect(fs.readdirSync(data.storage)).toEqual([]);
  });

  it('expires entries and enforces the actual stored-byte quota by LRU eviction', async () => {
    const expiring = cacheFixture({ ttlMs: 10 });
    await expiring.cache.set(expiring.createParsed('expiring'));
    expiring.advance(11);
    expect(await expiring.cache.get('expiring')).toBeNull();
    expect(fs.readdirSync(expiring.storage)).toEqual([]);

    const quotaSeed = cacheFixture();
    const first = quotaSeed.createParsed('first');
    const second = quotaSeed.createParsed('second');
    const quota = new WorkspaceArtifactCache({ rootDirectory: path.join(quotaSeed.root, 'quota'), maxBytes: first.bytes + second.bytes - 1 });
    await quota.set(first);
    await quota.set(second);
    expect(await quota.get('first')).toBeNull();
    expect((await quota.get('second')).artifact.id).toBe('second');
  });

  it('reports stored corruption explicitly instead of returning an empty result', async () => {
    const data = cacheFixture();
    await data.cache.set(data.createParsed('corrupt'));
    const storedPath = path.join(data.storage, fs.readdirSync(data.storage)[0]);
    fs.writeFileSync(storedPath, '{corrupt', { mode: 0o600 });
    await expect(data.cache.get('corrupt')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('fails safely when the storage root is a symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-artifact-symlink-'));
    const target = path.join(root, 'target');
    const storage = path.join(root, 'workspace-exports');
    fs.mkdirSync(target);
    fs.symlinkSync(target, storage);
    const cache = new WorkspaceArtifactCache({ rootDirectory: storage });
    await expect(cache.get('missing')).rejects.toThrow(/storage root is unsafe/);
  });
});
