import { describe, expect, it } from 'vitest';
import { discoverLfs, parseLfsPointer, scanLfsFiles, scanLfsPushObjects, resolveLfsPushConfig, LFS_DISCOVERY_LIMITS } from './lfs-discovery.js';

const OID = 'a'.repeat(64);
const pointer = (size = 42) => [
  'version https://git-lfs.github.com/spec/v1',
  `oid sha256:${OID}`,
  `size ${size}`,
  '',
].join('\n');
const configOutput = (records) => records.map(([key, value]) => `${key}\n${value}\0`).join('');
const attributesOutput = (records) => records.map(([path, value]) => `${path}\0filter\0${value}\0`).join('');

const input = (overrides = {}) => ({
  attributesOutput: attributesOutput([['assets/model.bin', 'lfs']]),
  pointerSamples: [{ path: 'assets/model.bin', content: pointer() }],
  gitRemoteName: 'origin',
  gitRemoteUrl: 'https://example.com/team/repository.git',
  lfsBinaryAvailable: true,
  ...overrides,
});

const scanFixture = (files, { attribute = () => 'unspecified', transform = (_args, output) => output } = {}) => {
  const calls = [];
  const objects = new Map(files.map((file, index) => [String(index + 1).padStart(40, '0'), file]));
  const byPath = new Map([...objects].map(([oid, file]) => [file.path, { oid, file }]));
  const query = async (args, data) => {
    calls.push({ args, bytes: data.length });
    const paths = data.toString().slice(0, -1).split(args[0] === 'check-attr' ? '\0' : '\n');
    let output;
    if (args[0] === 'check-attr') {
      output = Buffer.from(attributesOutput(paths.map((file) => [file, attribute(file)])));
    } else if (args[1] === '--batch-check') {
      output = Buffer.from(paths.map((ref) => {
        const { oid, file } = ref.startsWith('HEAD:') ? byPath.get(ref.slice('HEAD:'.length)) : { oid: ref, file: objects.get(ref) };
        return `${oid} ${file.type ?? 'blob'} ${Buffer.byteLength(file.content)}\n`;
      }).join(''));
    } else {
      output = Buffer.concat(paths.flatMap((oid) => {
        const content = Buffer.from(objects.get(oid).content);
        expect(content.length).toBeLessThanOrEqual(LFS_DISCOVERY_LIMITS.maxPointerBytes);
        return [Buffer.from(`${oid} blob ${content.length}\n`), content, Buffer.from('\n')];
      }));
    }
    expect(output.length).toBeLessThanOrEqual(LFS_DISCOVERY_LIMITS.maxBatchBytes);
    return transform(args, output, calls.length);
  };
  return { calls, run: () => scanLfsFiles(Buffer.from(files.map((file) => `${file.path}\0`).join('')), query),
    runPush: () => scanLfsPushObjects(Buffer.from([...objects.keys()].map((oid) => `${oid}\n`).join('')), query) };
};

describe('LFS publication discovery', () => {
  it('scans 10000 reachable objects in bounded batches, including a late pointer and duplicate LFS OIDs', async () => {
    const files = Array.from({ length: 10_000 }, (_, index) => ({ path: `file-${index}`, content: 'ordinary' }));
    files[9_998].content = pointer();
    files[9_999].content = pointer();
    const fixture = scanFixture(files);
    expect(await fixture.runPush()).toEqual([{ oid: OID, size: 42 }]);
    expect(fixture.calls).toHaveLength(2 * Math.ceil(10_000 / 128));
  });

  it('does not read large blobs or non-blob objects and tolerates small binary content', async () => {
    const fixture = scanFixture([
      { path: 'large', content: Buffer.alloc(2048) }, { path: 'binary', content: Buffer.from([0, 255, 254]) },
      { path: 'tree', type: 'tree', content: pointer() }, { path: 'commit', type: 'commit', content: pointer() },
    ]);
    expect(await fixture.runPush()).toEqual([]);
    expect(fixture.calls).toHaveLength(2);
  });

  it.each(['--batch-check', '--batch'])('rejects incomplete push %s output', async (command) => {
    const fixture = scanFixture([{ path: 'file', content: pointer() }], {
      transform: (args, output) => args.includes(command) ? output.subarray(0, -1) : output,
    });
    await expect(fixture.runPush()).rejects.toThrow();
  });

  it('rejects invalid and over-limit reachable object listings and pointer results', async () => {
    for (const listing of ['invalid\n', 'a'.repeat(40), 'a'.repeat(LFS_DISCOVERY_LIMITS.maxFilesBytes + 1)]) {
      await expect(scanLfsPushObjects(listing, async () => { throw new Error('must not query'); })).rejects.toMatchObject({ code: expect.stringContaining('LFS') });
    }
    const fixture = scanFixture(Array.from({ length: 257 }, (_, index) => ({
      path: `file-${index}`, content: pointer().replace(OID, index.toString(16).padStart(64, '0')),
    })));
    await expect(fixture.runPush()).rejects.toMatchObject({ code: 'LFS_DISCOVERY_LIMIT_EXCEEDED' });
  });

  it.each([
    [[], [], 'https://example.com/team/repository.git/info/lfs'],
    [[['lfs.url', 'https://committed.example/storage']], [], 'https://committed.example/storage'],
    [[['lfs.url', 'https://committed.example/storage']], [['lfs.url', 'https://effective.example/storage']], 'https://effective.example/storage'],
    [[['lfs.pushurl', 'https://push.example/storage']], [['lfs.url', 'https://effective.example/storage']], 'https://push.example/storage'],
    [[], [['remote.origin.lfspushurl', 'https://remote-push.example/storage']], 'https://remote-push.example/storage'],
    [[], [['remote.other.lfspushurl', 'https://unselected.example/storage']], 'https://example.com/team/repository.git/info/lfs'],
  ])('resolves upload authority with committed %j and effective %j', (committed, effective, expected) => {
    expect(resolveLfsPushConfig({ ...input(), lfsConfigOutput: configOutput(committed), effectiveConfigOutput: configOutput(effective) }).endpoint.endpoint).toBe(expected);
  });

  it('requires an explicit HTTPS LFS endpoint for SSH and rejects executable or unsafe configuration', () => {
    const config = { ...input({ gitRemoteUrl: 'git@example.com:team/repository.git' }), lfsConfigOutput: '', effectiveConfigOutput: '' };
    expect(resolveLfsPushConfig(config).endpoint).toBeNull();
    for (const records of [
      [['lfs.pushurl', 'ssh://git@example.com/storage']], [['lfs.pushurl', 'https://user:secret@example.com/storage']],
      [['lfs.customtransfer.bad.path', '/private/command']], [['lfs.standalonetransferagent', 'custom']],
    ]) expect(() => resolveLfsPushConfig({ ...config, effectiveConfigOutput: configOutput(records) })).toThrow();
  });
});

describe('incremental LFS file discovery', () => {
  it('covers 10000 ordinary paths with bounded batches and no retained samples', async () => {
    const fixture = scanFixture(Array.from({ length: 10_000 }, (_, index) => ({ path: `file-${index}`, content: `ordinary ${index}` })));
    expect(await fixture.run()).toEqual({ attributesOutput: '', pointerSamples: [], pointerScanComplete: true });
    expect(fixture.calls).toHaveLength(3 * Math.ceil(10_000 / 128));
    expect(fixture.calls.every((call) => call.bytes <= LFS_DISCOVERY_LIMITS.maxBatchBytes)).toBe(true);
  });

  it.each([false, true])('finds a late unattributed pointer among binary and large blobs, attributes=%s', async (withAttributes) => {
    const files = Array.from({ length: 1_025 }, (_, index) => ({
      path: `file ${index}`, content: index % 2 ? Buffer.from([0, 255, 254, 10, 0]) : Buffer.alloc(32 * 1024, 120),
    }));
    files.push({ path: 'late-pointer', content: pointer() });
    const fixture = scanFixture(files, { attribute: (file) => withAttributes && file === 'file 0' ? 'lfs' : 'unspecified' });
    const result = discoverLfs(input(await fixture.run()));
    expect(result.needed).toBe(true);
    expect(result.pointers).toEqual([{ path: 'late-pointer', oid: OID, size: 42 }]);
    expect(result.attributePaths).toEqual(withAttributes ? ['file 0'] : []);
    expect(fixture.calls).toHaveLength(27);
  });

  it('skips large blobs and absent superproject gitlink objects without fetching content', async () => {
    const fixture = scanFixture([{ path: 'large', content: Buffer.alloc(2 * 1024 * 1024) }]);
    expect(await fixture.run()).toMatchObject({ pointerScanComplete: true, pointerSamples: [] });
    expect(fixture.calls).toHaveLength(2);
    await expect(scanLfsFiles('vendor/child\0', async () => { throw new Error('gitlink must not be queried'); }, ['vendor/child']))
      .resolves.toEqual({ pointerScanComplete: true, pointerSamples: [], attributesOutput: '' });
  });

  it.each(['check-attr', '--batch-check', '--batch'])('rejects truncated %s output', async (command) => {
    const fixture = scanFixture([{ path: 'file', content: 'ordinary' }], {
      transform: (args, output) => args.includes(command) ? output.subarray(0, -1) : output,
    });
    await expect(fixture.run()).rejects.toThrow();
  });

  it.each(['missing', 'wrong-oid', 'extra-content'])('rejects invalid object responses: %s', async (mode) => {
    const fixture = scanFixture([{ path: 'file', content: 'ordinary' }], {
      transform: (args, output) => {
        if (mode === 'missing' && args[1] === '--batch-check') return Buffer.from('HEAD:file missing\n');
        if (args[1] !== '--batch') return output;
        if (mode === 'wrong-oid') return Buffer.from(output.toString().replace(/^0/, 'f'));
        if (mode === 'extra-content') return Buffer.concat([output, Buffer.from('unexpected')]);
        return output;
      },
    });
    await expect(fixture.run()).rejects.toThrow();
  });

  it('keeps pointer and attribute public limits across batches', async () => {
    for (const attributes of [false, true]) {
      const fixture = scanFixture(Array.from({ length: 257 }, (_, index) => ({ path: `file-${index}`, content: attributes ? 'ordinary' : pointer() })),
        { attribute: () => attributes ? 'lfs' : 'unspecified' });
      await expect(fixture.run()).rejects.toMatchObject({ code: 'LFS_DISCOVERY_LIMIT_EXCEEDED' });
    }
  });

  it('does not query unsafe or incomplete paths and enforces the listing byte bound', async () => {
    for (const files of ['file', '../secret\0', 'file\ncommand\0', 'x'.repeat(LFS_DISCOVERY_LIMITS.maxFilesBytes + 1)]) {
      let queried = false;
      await expect(scanLfsFiles(files, async () => { queried = true; })).rejects.toThrow();
      expect(queried).toBe(false);
    }
  });
});

describe('Git LFS discovery', () => {
  it('validates pointers and derives a separate HTTPS endpoint authority', () => {
    expect(parseLfsPointer(pointer())).toEqual({ oid: OID, size: 42 });
    expect(parseLfsPointer('ordinary file content')).toBeNull();

    const result = discoverLfs(input());
    expect(result).toMatchObject({
      needed: true,
      attributePaths: ['assets/model.bin'],
      pointers: [{ path: 'assets/model.bin', oid: OID, size: 42 }],
      endpoint: {
        status: 'resolved',
        source: 'git-remote',
        candidate: {
          endpoint: 'https://example.com/team/repository.git/info/lfs',
          relationship: { sameHost: true, samePort: true, path: 'descendant' },
        },
      },
      client: { status: 'available' },
    });
  });

  it('uses explicit .lfsconfig authority before remote-specific input', () => {
    const result = discoverLfs(input({
      lfsConfigOutput: configOutput([['lfs.url', 'https://lfs.example.net/storage/repository']]),
      remoteLfsUrls: [{ remote: 'origin', url: 'https://ignored.example.com/repository' }],
    }));

    expect(result.endpoint).toMatchObject({
      status: 'resolved',
      source: 'lfsconfig',
      candidate: {
        endpoint: 'https://lfs.example.net/storage/repository',
        relationship: { sameHost: false, path: 'unrelated' },
      },
    });
    expect(result.needed).toBe(true);
  });

  it('supports an HTTPS LFS endpoint with an SSH Git remote and exposes cross-host facts', () => {
    const result = discoverLfs(input({
      gitRemoteUrl: 'git@git.example.com:team/repository.git',
      remoteLfsUrls: [{ remote: 'origin', url: 'https://media.example.net/team/repository' }],
      lfsBinaryAvailable: false,
    }));

    expect(result.endpoint).toMatchObject({
      status: 'resolved',
      source: 'remote',
      candidate: {
        kind: 'https',
        endpoint: 'https://media.example.net/team/repository',
        relationship: { sameHost: false, samePort: true, path: 'sibling' },
      },
    });
    expect(result.client).toEqual({
      status: 'missing', code: 'GIT_LFS_CLIENT_MISSING', action: 'install-git-lfs',
    });
    expect(JSON.stringify(result)).not.toMatch(/credential|password|token/i);
  });

  it('returns typed unresolved SSH authority and not-required client states', () => {
    const result = discoverLfs(input({
      attributesOutput: '',
      pointerSamples: [{ path: 'README.md', content: 'plain text' }],
      gitRemoteUrl: 'ssh://git@example.com/team/repository.git',
      lfsBinaryAvailable: false,
    }));
    expect(result.needed).toBe(false);
    expect(result.endpoint).toEqual({ status: 'unresolved', reason: 'ssh-git-remote' });
    expect(result.client).toEqual({ status: 'not-required' });
  });

  it('never reports not-needed when pointer sampling is incomplete', () => {
    expect(() => discoverLfs(input({
      attributesOutput: '',
      pointerSamples: [{ path: 'README.md', content: 'plain text' }],
      pointerScanComplete: false,
    }))).toThrow(expect.objectContaining({ code: 'LFS_DISCOVERY_LIMIT_EXCEEDED' }));
  });

  it.each([
    ['bad oid', pointer().replace(OID, 'abc')],
    ['negative size', pointer().replace('size 42', 'size -1')],
    ['duplicate oid', pointer().replace('size 42', `oid sha256:${OID}\nsize 42`)],
    ['wrong order', pointer().replace(`oid sha256:${OID}\nsize 42`, `size 42\noid sha256:${OID}`)],
    ['wrong pointer version', pointer().replace('/spec/v1', '/spec/v2')],
    ['CRLF', pointer().replaceAll('\n', '\r\n')],
  ])('rejects malformed pointer: %s', (_label, content) => {
    expect(() => parseLfsPointer(content)).toThrow('malformed');
  });

  it.each([
    'http://example.com/repository.git/info/lfs',
    'file:///tmp/lfs',
    'https://user:secret@example.com/lfs',
    'https://example.com/lfs?token=secret',
    'ext::run-command',
  ])('rejects malformed or unsafe LFS endpoint %s', (url) => {
    expect(() => discoverLfs(input({
      lfsConfigOutput: configOutput([['lfs.url', url]]),
    }))).toThrow('LFS endpoint');
  });

  it.each([
    ['lfs.customtransfer.bad.path', '/tmp/program'],
    ['lfs.customtransfer.bad.args', '--execute'],
    ['lfs.standalonetransferagent', 'custom'],
    ['filter.lfs.process', 'sh -c bad'],
    ['filter.lfs.clean', '/tmp/filter %f'],
  ])('rejects executable transfer configuration %s', (key, value) => {
    expect(() => discoverLfs(input({
      effectiveConfigOutput: configOutput([[key, value]]),
    }))).toThrow(expect.objectContaining({ code: 'UNSAFE_LFS_EXECUTABLE_CONFIG' }));
  });

  it('accepts canonical LFS filters but rejects unsupported repository config keys', () => {
    expect(() => discoverLfs(input({
      effectiveConfigOutput: configOutput([
        ['filter.lfs.process', 'git-lfs filter-process'],
        ['filter.lfs.clean', 'git-lfs clean -- %f'],
        ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
      ]),
    }))).not.toThrow();
    expect(() => discoverLfs(input({
      lfsConfigOutput: configOutput([['core.sshCommand', 'bad']]),
    }))).toThrow('Unsupported .lfsconfig key');
  });

  it('rejects incomplete attributes/config output and unsafe paths', () => {
    expect(() => discoverLfs(input({ attributesOutput: 'asset.bin\0filter\0lfs' }))).toThrow('incomplete');
    expect(() => discoverLfs(input({ lfsConfigOutput: 'lfs.url\nhttps://example.com/lfs' }))).toThrow('incomplete');
    expect(() => discoverLfs(input({
      pointerSamples: [{ path: '../secret', content: pointer() }],
    }))).toThrow('path is unsafe');
    expect(() => discoverLfs(input({
      remoteLfsUrls: [{ remote: 'backup', url: 'http://example.com/unsafe' }],
    }))).toThrow('LFS endpoint');
  });

  it('enforces attribute, config, pointer, sample, remote, and public-record bounds', () => {
    expect(() => discoverLfs(input(), { maxAttributesBytes: 2 })).toThrow(expect.objectContaining({
      code: 'LFS_DISCOVERY_LIMIT_EXCEEDED',
    }));
    expect(() => discoverLfs(input({
      lfsConfigOutput: configOutput([['lfs.url', 'https://example.com/lfs']]),
    }), { maxConfigBytes: 2 })).toThrow(expect.objectContaining({ code: 'LFS_DISCOVERY_LIMIT_EXCEEDED' }));
    expect(() => discoverLfs(input(), { maxPointerBytes: 2 })).toThrow(expect.objectContaining({
      code: 'LFS_DISCOVERY_LIMIT_EXCEEDED',
    }));
    expect(() => discoverLfs(input(), { maxPointerSamples: 0 })).toThrow(expect.objectContaining({
      code: 'LFS_DISCOVERY_LIMIT_EXCEEDED',
    }));
    expect(() => discoverLfs(input({
      remoteLfsUrls: [{ remote: 'origin', url: 'https://example.com/lfs' }],
    }), { maxRemoteUrls: 0 })).toThrow(expect.objectContaining({ code: 'LFS_DISCOVERY_LIMIT_EXCEEDED' }));
    expect(() => discoverLfs(input(), { maxPublicRecords: 0 })).toThrow(expect.objectContaining({
      code: 'LFS_DISCOVERY_LIMIT_EXCEEDED',
    }));
  });
});
