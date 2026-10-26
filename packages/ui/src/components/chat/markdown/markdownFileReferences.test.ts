import { describe, expect, test } from 'bun:test';
import { confirmCodePaths, resolveMarkdownFile } from './markdownFileReferences';

const probes = (values: string[]) => values.filter((value) => resolveMarkdownFile(value, '/repo') !== null);

describe('resolveMarkdownFile', () => {
  test('probes skip emails and digit-leading suffixes while keeping file references (#5330)', () => {
    const rejected = [
      'user@gmail.com', '@someone.ts',
      'gpt-5.4', '93.00', '3.49s', 'v1.2.3', '3.1.4', 'ls.1',
      'backup.7z', 'clip.3gp', 'data.001',
      'https://example.com/file.ts', '--flag.ts', '.', '..', 'a  b.ts',
    ];
    const accepted = [
      // A slash makes an `@` part of a path: scoped packages and pnpm stores.
      '@scope/package.json', 'node_modules/@types/node/index.d.ts',
      '.env', '.config.json', './src/entry.ts', '../src/parent.ts', '/repo/absolute.ts',
      'path with spaces/file name.ts', 'file.test.ts', 'my-file.tar.gz', 'a-b.c',
      'shader.frag2', 'component.d-ts', 'README', 'Dockerfile',
      // Still ambiguous with filenames that have letter-leading extensions.
      '150.ms', 'accounts.google.com', 'client.messages.create',
    ];
    expect(probes(rejected)).toEqual([]);
    expect(probes(accepted)).toEqual(accepted);
  });

  test('clicks keep the broad rules so file links never open a new window (#3858)', () => {
    for (const href of ['backup.7z', 'icon@2x.png', 'data.001', 'file:///repo/data.001']) {
      expect(resolveMarkdownFile(href, '/repo', 'click')).not.toBeNull();
    }
    expect(resolveMarkdownFile('file:///repo/data.001', '/repo', 'click')?.resolvedPath).toBe('/repo/data.001');
  });

  test('code blocks probe only path-like tokens that pass the probe rules', async () => {
    const asked: string[] = [];
    const confirmed = await confirmCodePaths('gpt-5.4\nuser@gmail.com\nblock/entry.ts:7\n', '/repo', 80, async (raw) => {
      asked.push(raw);
      return `/repo/${raw.replace(/:\d+$/, '')}`;
    });
    expect(asked).toEqual(['block/entry.ts:7']);
    expect(confirmed.map((path) => path.raw)).toEqual(['block/entry.ts:7']);
  });
});
