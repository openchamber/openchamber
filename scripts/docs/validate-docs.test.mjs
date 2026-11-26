import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.join(import.meta.dirname, 'validate-docs.mjs');
const roots = [];

const page = (title, body = '') => `---\ntitle: ${title}\ndescription: About ${title}\n---\n\n${body}\n`;

function docsFolder(pages, sidebarLinks = ['/']) {
  const root = mkdtempSync(path.join(tmpdir(), 'validate-docs-'));
  roots.push(root);
  for (const [file, content] of Object.entries(pages)) {
    const target = path.join(root, 'content', 'docs', file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(
    path.join(root, 'sidebar.config.json'),
    JSON.stringify({ sections: [{ items: sidebarLinks.map((link) => ({ label: link, link })) }] }),
  );
  return root;
}

function validate(root) {
  const result = spawnSync('node', [script, root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('docs validation', () => {
  test('passes internal page links that resolve, with anchors, locales and assets', () => {
    const root = docsFolder({
      'index.mdx': page(
        'Home',
        [
          'See [Git](/git/#push), [Ukrainian Git](/uk/git/), [no slash](/git) and <a href="/sdk/">SDK</a>.',
          '![logo](/images/logo.png)',
        ].join('\n'),
      ),
      'git.mdx': page('Git'),
      'uk/git.mdx': page('Git'),
      'sdk/index.mdx': page('SDK'),
    });

    const result = validate(root);
    expect(result.output).toContain('Docs validation passed');
    expect(result.status).toBe(0);
  });

  test('fails a page body link to a missing page, naming the page and the link', () => {
    const root = docsFolder({
      'index.mdx': page('Home', 'Read [the guide](/missing-page/#setup).'),
    });

    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/content\/docs\/index\.mdx: link has no page: \/missing-page\/#setup/);
  });

  test('ignores links inside code', () => {
    const root = docsFolder({
      'index.mdx': page('Home', ['`[x](/nowhere/)`', '```md', '[x](/nowhere/)', '```'].join('\n')),
    });

    expect(validate(root).status).toBe(0);
  });

  test('ignores links inside an indented fence in a list item', () => {
    const root = docsFolder({
      'index.mdx': page('Home', ['1. Add a link:', '', '   ```md', '   [Example](/placeholder/)', '   ```'].join('\n')),
    });

    expect(validate(root).status).toBe(0);
  });

  test('fails angle-bracket and reference links to a missing page', () => {
    const root = docsFolder({
      'index.mdx': page('Home', ['[Install](</missing-a/>)', '', '[Install][install]', '', '[install]: /missing-b/'].join('\n')),
    });

    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('content/docs/index.mdx: link has no page: /missing-a/');
    expect(result.output).toContain('content/docs/index.mdx: link has no page: /missing-b/');
  });

  test('resolves dot segments before looking up the page', () => {
    const root = docsFolder({
      'index.mdx': page('Home', '[Install](/guides/../install/) and [ref][i]\n\n[i]: </install/>'),
      'install.mdx': page('Install'),
    });

    const result = validate(root);
    expect(result.output).toContain('Docs validation passed');
    expect(result.status).toBe(0);
  });

  test('still reports missing frontmatter and sidebar links without a page', () => {
    const root = docsFolder({ 'index.mdx': '---\ntitle: Home\n---\n' }, ['/', '/gone/']);

    const result = validate(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("missing frontmatter key 'description'");
    expect(result.output).toContain('sidebar link has no page: /gone/');
  });
});
