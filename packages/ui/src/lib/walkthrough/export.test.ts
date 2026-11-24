import { describe, expect, test as it } from 'bun:test';
import type { Paragraph, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { walkthroughExportFile } from './export';
import type { I18nParams } from '@/lib/i18n';
import type { WalkthroughHunk, WalkthroughResult } from './types';

const t = (key: string, params?: I18nParams) =>
  params ? `${key}(${Object.values(params).join(',')})` : key;

const toString = (node: Root | RootContent): string =>
  'value' in node ? node.value : 'children' in node ? node.children.map(toString).join('') : '';

const hunk = (id: string, path: string, body: string): WalkthroughHunk => ({
  id,
  path,
  oldPath: null,
  status: 'modified',
  scope: 'working',
  header: '@@ -1 +1 @@',
  newStart: 1,
  added: 1,
  deleted: 1,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`,
});

const result = (overrides: Partial<WalkthroughResult> = {}): WalkthroughResult => ({
  source: { kind: 'working-tree', scope: 'all' },
  walkthrough: {
    title: 'Typed <img src=x onerror=alert(1)> math 日本語',
    focus: 'Callers get typed results.',
    chapters: [
      {
        id: 'c1',
        title: 'Types',
        icon: 'wrench',
        blurb: 'Signatures',
        stops: [
          {
            id: 's1',
            title: 'add takes numbers',
            hunkIds: ['math'],
            importance: 'critical',
            prose: 'Now typed.\n```\nnot a fence\n```\n</script><script>alert(2)</script> [x](javascript:alert(3))',
            observations: [{ kind: 'unproven', note: 'No test covers <b>sub</b>.' }],
          },
          { id: 's2', title: 'Removed helper', hunkIds: ['gone'], importance: 'context', prose: 'Gone now.' },
        ],
      },
      {
        id: 'c2',
        title: 'التوثيق',
        icon: 'doc',
        blurb: '',
        stops: [{ id: 's3', title: 'عنوان', hunkIds: ['readme', 'old'], importance: 'normal', prose: 'نص عربي' }],
      },
    ],
    routine: [{ path: 'package.json', note: 'Version bump.' }],
  },
  hunks: [
    hunk('math', 'src/math.ts', '-old\n+const s = "````";'),
    hunk('readme', 'docs/readme.md', '-a\n+b'),
    hunk('pkg', 'package.json', '-{"a":1}\n+{"a":2}'),
  ],
  hunkCount: 3,
  language: 'ar',
  ...overrides,
});

describe('walkthroughExportFile', () => {
  it('writes every stop in order with its warnings, code and the uncovered tail', async () => {
    const file = walkthroughExportFile(result(), 'markdown', t);
    expect(file?.name).toBe('walkthrough-typed-img-src-x-onerror-alert-1-math-日本語.md');
    expect(file?.type).toContain('text/markdown');
    const text = await file!.text();
    const order = [
      '# Typed \\<img src=x onerror=alert(1)> math 日本語',
      'Callers get typed results.',
      '> walkthrough.stale.banner(2)',
      '## Types',
      'Signatures',
      '### 1. add takes numbers',
      '**walkthrough.importance.critical**',
      '- **walkthrough.observation.unproven:** No test covers \\<b>sub\\</b>.',
      '`src/math.ts`',
      '`````diff',
      '### 2. Removed helper',
      '> walkthrough.stop.staleAll',
      '> walkthrough.stop.noCode',
      '## التوثيق',
      '### 3. عنوان',
      '> walkthrough.stop.stalePartial(1)',
      '`docs/readme.md`',
      '## walkthrough.uncovered.title(1)',
      '`package.json`',
      'Version bump.',
      '+{"a":2}',
    ];
    let cursor = 0;
    for (const part of order) {
      const found = text.indexOf(part, cursor);
      expect({ part, found: found >= 0 }).toEqual({ part, found: true });
      cursor = found + part.length;
    }
  });

  it('keeps model text from opening fences, HTML or links in Markdown', async () => {
    const text = await walkthroughExportFile(result(), 'markdown', t)!.text();
    expect(text).toContain('Now typed. \\`\\`\\` not a fence \\`\\`\\` \\</script>\\<script>alert(2)\\</script> \\[x](javascript:alert(3))');
    expect(text).toContain('`````diff\ndiff --git a/src/math.ts');
    expect(text).toContain('+const s = "````";\n`````');
  });

  it('writes a standalone HTML page where model text cannot run or load anything', async () => {
    const file = walkthroughExportFile(result(), 'html', t);
    expect(file?.name.endsWith('.html')).toBe(true);
    const html = await file!.text();
    expect(html.startsWith('<!doctype html><html lang="ar" dir="rtl">')).toBe(true);
    expect(html).toContain('content="default-src \'none\'; style-src \'unsafe-inline\'"');
    expect(/<(script|img|link|iframe|b)\b/i.test(html)).toBe(false);
    expect(/<[^>]*\b(src|href|on\w+)=/i.test(html)).toBe(false);
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('<span class="add">+const s = &quot;````&quot;;</span>');
    expect(html).toContain('<h2 dir="auto">walkthrough.uncovered.title(1)</h2><h4 class="path" dir="ltr">package.json</h4><p class="muted" dir="auto">Version bump.</p>');
    expect(html.match(/<article>/g)?.length).toBe(3);
  });

  it('keeps model prose literal in GFM: no emphasis, code or autolinks', async () => {
    const prose = 'Match foo*bar*baz and _x_ with `cmd`, see https://example.com/a_b. or www.example.org, after _https://example.net, mail dev@example.com';
    const file = walkthroughExportFile(result({
      walkthrough: {
        title: 'T',
        focus: '',
        chapters: [{ id: 'c', title: 'C', icon: 'wrench', blurb: '', stops: [{ id: 's', title: 'S', hunkIds: [], importance: 'normal', prose }] }],
      },
      hunks: [],
      hunkCount: 0,
    }), 'markdown', t);
    const processor = unified().use(remarkParse).use(remarkGfm);
    const tree = processor.parse(await file!.text());
    const paragraph = tree.children.find((node): node is Paragraph => node.type === 'paragraph' && toString(node).startsWith('Match'));
    expect(paragraph && toString(paragraph)).toBe(prose);
    const kinds = new Set<string>();
    const visit = (node: Root | RootContent) => {
      kinds.add(node.type);
      if ('children' in node) node.children.forEach(visit);
    };
    visit(paragraph!);
    expect([...kinds].filter((kind) => !['paragraph', 'text', 'inlineCode'].includes(kind))).toEqual([]);
  });

  it('keeps a staged and a working edit of one file under their own headers', async () => {
    const staged: WalkthroughHunk = {
      ...hunk('staged', 'src/a.ts', '-one\n+two'),
      scope: 'staged',
      patch: 'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+two\n',
    };
    const working: WalkthroughHunk = {
      ...hunk('working', 'src/a.ts', '-two\n+three'),
      patch: 'diff --git a/src/a.ts b/src/a.ts\nindex 222..333 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-two\n+three\n',
    };
    const both = result({
      walkthrough: {
        title: 'T',
        focus: '',
        chapters: [{ id: 'c', title: 'C', icon: 'wrench', blurb: '', stops: [{ id: 's', title: 'S', hunkIds: ['staged', 'working'], importance: 'normal', prose: '' }] }],
      },
      hunks: [staged, working],
      hunkCount: 2,
    });
    const markdown = await walkthroughExportFile(both, 'markdown', t)!.text();
    expect(markdown).toContain(`\`\`\`diff\n${staged.patch}\`\`\``);
    expect(markdown).toContain(`\`\`\`diff\n${working.patch}\`\`\``);
    const html = await walkthroughExportFile(both, 'html', t)!.text();
    expect(html.match(/<pre /g)?.length).toBe(2);
    expect(html).toContain('index 111..222 100644');
    expect(html).toContain('index 222..333 100644');
  });

  it('colours added and removed lines that start with ++ or -- as changes', async () => {
    const html = await walkthroughExportFile(result({
      hunks: [hunk('math', 'src/math.ts', '---count;\n+++count;')],
      hunkCount: 1,
    }), 'html', t)!.text();
    expect(html).toContain('<span class="meta">--- a/src/math.ts</span><span class="meta">+++ b/src/math.ts</span>');
    expect(html).toContain('<span class="del">---count;</span><span class="add">+++count;</span>');
  });

  it('names a file by its exact path and survives a patch full of backtick runs', async () => {
    const path = 'docs/release  notes.md';
    const body = `+${'a`'.repeat(1_000_000)}`;
    const file = walkthroughExportFile(result({
      walkthrough: { title: 'T', focus: '', chapters: [], routine: [{ path, note: '' }] },
      hunks: [hunk('notes', path, body)],
      hunkCount: 1,
    }), 'markdown', t);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(await file!.text());
    const label = tree.children.find((node): node is Paragraph => node.type === 'paragraph' && node.children[0]?.type === 'inlineCode');
    expect(label && toString(label)).toBe(path);
    const code = tree.children.find((node) => node.type === 'code');
    expect(code && toString(code)).toBe(hunk('notes', path, body).patch.replace(/\n$/, ''));
  });

  it('exports nothing for a result without a walkthrough', () => {
    expect(walkthroughExportFile(result({ walkthrough: null }), 'markdown', t)).toBeNull();
    expect(walkthroughExportFile(result({ walkthrough: null }), 'html', t)).toBeNull();
  });
});
