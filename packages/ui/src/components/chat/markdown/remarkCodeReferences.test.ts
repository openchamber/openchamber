import { describe, expect, test } from 'bun:test';
import type { Code, Link, Paragraph, Root } from 'mdast';

import { remarkCodeReferences } from './remarkCodeReferences';

const transform = remarkCodeReferences('/repo');

const paragraphOf = (tree: Root, index = 0): Paragraph => {
  const node = tree.children[index];
  if (!node || node.type !== 'paragraph') throw new Error(`expected a paragraph at ${index}`);
  return node;
};

const linkOf = (children: Paragraph['children'], index: number): Link => {
  const child = children[index];
  if (!child || child.type !== 'link') throw new Error(`expected a link at ${index}`);
  return child;
};

const run = (children: Root['children']): Root => {
  const tree: Root = { type: 'root', children };
  transform(tree);
  return tree;
};

describe('remarkCodeReferences', () => {
  test('links a code reference in a paragraph and keeps the text around it', () => {
    const tree = run([{ type: 'paragraph', children: [{ type: 'text', value: 'fix src/a.ts:2 first' }] }]);
    const children = paragraphOf(tree).children;
    expect(children.map((child) => child.type)).toEqual(['text', 'link', 'text']);
    const link = linkOf(children, 1);
    expect(link.url).toBe('src/a.ts');
    expect(link.children).toEqual([{ type: 'inlineCode', value: 'src/a.ts:2' }]);
    expect(link.data?.hProperties).toMatchObject({ dataOcCodeRef: '/repo/src/a.ts', dataOcCodeRefDir: '/repo', dataOcCodeRefLine: '2' });
  });

  test('leaves a line-less reference without the line attribute', () => {
    const tree = run([{ type: 'paragraph', children: [{ type: 'text', value: 'see lib/x.tsx' }] }]);
    const link = linkOf(paragraphOf(tree).children, 1);
    expect(link.data?.hProperties).toMatchObject({ dataOcCodeRef: '/repo/lib/x.tsx', dataOcCodeRefDir: '/repo' });
    expect(link.data?.hProperties).not.toHaveProperty('dataOcCodeRefLine');
  });

  test('keeps fenced and inline code, link children and raw html unlinked', () => {
    const prose: Paragraph['children'] = [
      { type: 'inlineCode', value: 'src/a.ts:2' },
      { type: 'text', value: 'src/a.ts:2 in prose ' },
      { type: 'html', value: '<code>' },
      { type: 'text', value: 'src/a.ts:2' },
      { type: 'html', value: '</code>' },
      { type: 'link', url: 'https://example.com/x', children: [{ type: 'text', value: 'src/a.ts:2' }] },
    ];
    const code: Code = { type: 'code', lang: 'ts', value: 'src/a.ts:2' };
    const tree = run([{ type: 'paragraph', children: prose }, code]);
    const children = paragraphOf(tree).children;
    // Only the prose occurrence links; the inline code, the author's raw code
    // span and the existing link keep their text.
    expect(children.filter((child) => child.type === 'link')).toHaveLength(2);
    expect(children[0].type).toBe('inlineCode');
    expect(children[4]).toMatchObject({ type: 'text', value: 'src/a.ts:2' });
    expect(tree.children[1]).toMatchObject({ type: 'code', value: 'src/a.ts:2' });
    const original = linkOf(children, 6);
    expect(original.url).toBe('https://example.com/x');
    expect(original.children[0]).toMatchObject({ type: 'text', value: 'src/a.ts:2' });
  });

  test('keeps a path that resolves outside the folder as text', () => {
    const tree = run([{ type: 'paragraph', children: [{ type: 'text', value: 'see ../outside/a.ts here' }] }]);
    const children = paragraphOf(tree).children;
    expect(children.filter((child) => child.type === 'link')).toHaveLength(0);
    expect(children.map((child) => ('value' in child ? child.value : '')).join('')).toBe('see ../outside/a.ts here');
  });

  test('leaves a text node without references untouched', () => {
    const text = { type: 'text', value: 'no references at all' } as const;
    const tree = run([{ type: 'paragraph', children: [text] }]);
    expect(paragraphOf(tree).children[0]).toBe(text);
  });
});
