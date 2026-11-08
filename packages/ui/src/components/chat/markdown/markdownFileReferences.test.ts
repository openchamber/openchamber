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

  test('decodes ordinary href paths for both confirmation and clicks (#5660)', () => {
    for (const purpose of ['probe', 'click'] as const) {
      for (const href of ['docs/中文/示例.md', 'docs/%E4%B8%AD%E6%96%87/%E7%A4%BA%E4%BE%8B.md', '/repo/docs/%E4%B8%AD%E6%96%87/%E7%A4%BA%E4%BE%8B.md']) {
        expect(resolveMarkdownFile(href, '/repo', purpose, 'href')?.resolvedPath).toBe('/repo/docs/中文/示例.md');
      }
      expect(resolveMarkdownFile('docs/file%20name.md', '/repo', purpose, 'href')?.resolvedPath).toBe('/repo/docs/file name.md');
      expect(resolveMarkdownFile('file:///repo/docs/%E4%B8%AD%E6%96%87.md', '/repo', purpose, 'href')?.resolvedPath).toBe('/repo/docs/中文.md');
    }
    expect(resolveMarkdownFile('/C:/repo/%E4%B8%AD%E6%96%87.md', 'C:/repo', 'click', 'href')?.resolvedPath).toBe('C:/repo/中文.md');
  });

  test('keeps escaped filename characters separate from reference suffixes', () => {
    for (const [href, path] of [
      ['docs/a%23b.md', '/repo/docs/a#b.md'],
      ['docs/a%3Bb.md', '/repo/docs/a;b.md'],
      ['docs/a%3A12.md', '/repo/docs/a:12.md'],
      ['docs/a%23L12.md', '/repo/docs/a#L12.md'],
      ['docs/50%25off.md', '/repo/docs/50%off.md'],
      ['docs/50%2525off.md', '/repo/docs/50%25off.md'],
    ]) {
      expect(resolveMarkdownFile(href, '/repo', 'click', 'href')).toEqual({ path: path.slice('/repo/'.length), resolvedPath: path });
    }
    expect(resolveMarkdownFile('docs/a%23b.md#L12C3', '/repo', 'click', 'href')).toEqual({ path: 'docs/a#b.md', line: 12, column: 3, resolvedPath: '/repo/docs/a#b.md' });
    expect(resolveMarkdownFile('docs/%E4%B8%AD%E6%96%87.md:12:3', '/repo', 'click', 'href')).toEqual({ path: 'docs/中文.md', line: 12, column: 3, resolvedPath: '/repo/docs/中文.md' });
    expect(resolveMarkdownFile('docs/%E4%B8%AD%E6%96%87.md:12-20', '/repo', 'click', 'href')).toEqual({ path: 'docs/中文.md', line: 12, endLine: 20, resolvedPath: '/repo/docs/中文.md' });
  });

  test('preserves encoded edge spaces in href filenames', () => {
    for (const purpose of ['probe', 'click'] as const) {
      for (const [href, path] of [
        ['%20%20report.md', '/repo/  report.md'],
        ['report.md%20%20', '/repo/report.md  '],
        ['/repo/report.md%20%20', '/repo/report.md  '],
        ['../report.md%20%20', '/report.md  '],
        ['%20%20/other.md', '/repo/  /other.md'],
      ]) {
        expect(resolveMarkdownFile(href, '/repo', purpose, 'href')?.resolvedPath).toBe(path);
      }
      expect(resolveMarkdownFile('/C:/repo/report.md%20%20', 'C:/repo', purpose, 'href')?.resolvedPath).toBe('C:/repo/report.md  ');
    }
  });

  test('preserves native escape-looking paths and tolerates malformed hrefs', () => {
    for (const purpose of ['probe', 'click'] as const) {
      for (const raw of ['docs/50%25off.md', 'docs/%E4%B8%AD.md', 'docs/a%20%20b.md']) {
        expect(resolveMarkdownFile(raw, '/repo', purpose)?.resolvedPath).toBe(`/repo/${raw}`);
      }
      for (const href of ['docs/%ZZbad.md', 'docs/100%.md', 'docs/%E4.md']) {
        expect(resolveMarkdownFile(href, '/repo', purpose, 'href')?.resolvedPath).toBe(`/repo/${href}`);
      }
    }
    expect(resolveMarkdownFile('../%E4%B8%AD.md', '/repo/docs', 'click', 'href')?.resolvedPath).toBe('/repo/中.md');
    expect(resolveMarkdownFile('https://example.com/%E4%B8%AD.md', '/repo', 'click', 'href')).toBeNull();
  });

  test('explicit local hrefs accept filename characters that prose probes reject', () => {
    for (const purpose of ['probe', 'click'] as const) {
      for (const [href, path] of [
        ['docs/a%20%20b.md', 'docs/a  b.md'],
        ['docs/a%3Cb.md', 'docs/a<b.md'],
        ['docs/a%3Eb.md', 'docs/a>b.md'],
        ['docs/a%3A%2F%2Fb.md', 'docs/a:/b.md'],
      ]) {
        expect(resolveMarkdownFile(href, '/repo', purpose, 'href')?.resolvedPath).toBe(`/repo/${path}`);
      }
      for (const href of ['https://example.com/a.md', 'http://example.com/a%3Cb.md', '//example.com/a.md', 'mailto:user@example.com', 'custom:docs/a.md']) {
        expect(resolveMarkdownFile(href, '/repo', purpose, 'href')).toBeNull();
      }
    }
    for (const raw of ['docs/a  b.md', 'docs/a<b.md', 'docs/a>b.md', 'docs/a://b.md']) {
      expect(resolveMarkdownFile(raw, '/repo')).toBeNull();
    }
    expect(resolveMarkdownFile('C:/repo/a%20%20b.md:12', 'C:/repo', 'click', 'href')).toEqual({
      path: 'C:/repo/a  b.md', resolvedPath: 'C:/repo/a  b.md', line: 12, column: undefined,
    });
  });
});
