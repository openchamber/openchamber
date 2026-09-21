import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  getLocalPreviewImagePath,
  resolveLocalPreviewImagePath,
  resolveMarkdownPreviewImages,
} from './markdownPreviewImages';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, Element: dom.Element });
const createElement = (): HTMLDivElement => document.createElement('div');
describe('Markdown preview embedded images', () => {
  test('returns a local path for image sources', () => {
    expect(getLocalPreviewImagePath('./assets/pic.svg')).toBe('./assets/pic.svg');
    expect(getLocalPreviewImagePath('/Users/rek/notes/image.png?q=1')).toBe('/Users/rek/notes/image.png');
    expect(getLocalPreviewImagePath('../shared/logo.png')).toBe('../shared/logo.png');
    expect(getLocalPreviewImagePath('C:/docs/diagram.svg')).toBe('C:/docs/diagram.svg');
    expect(getLocalPreviewImagePath('file:///Users/rek/notes/image.png')).toBe('/Users/rek/notes/image.png');
  });

  test('rejects remote, data, and non-image sources', () => {
    expect(getLocalPreviewImagePath('https://example.test/image.png')).toBe('');
    expect(getLocalPreviewImagePath('//example.test/image.png')).toBe('');
    expect(getLocalPreviewImagePath('data:image/svg+xml;base64,AAAA')).toBe('');
    expect(getLocalPreviewImagePath('./docs/report.pdf')).toBe('');
    expect(getLocalPreviewImagePath('./notes/readme.md')).toBe('');
    expect(getLocalPreviewImagePath('./scripts/main.ts')).toBe('');
    expect(getLocalPreviewImagePath('')).toBe('');
  });

  test('resolves embedded sources against the markdown file directory', () => {
    expect(resolveLocalPreviewImagePath({
      source: './assets/pic.svg',
      filePath: 'docs/guide/readme.md',
      directory: '/Users/rek/project',
    })).toBe('/Users/rek/project/docs/guide/assets/pic.svg');
    expect(resolveLocalPreviewImagePath({
      source: 'pic.png',
      filePath: '/Users/rek/project/readme.md',
      directory: '/Users/rek/project',
    })).toBe('/Users/rek/project/pic.png');
    expect(resolveLocalPreviewImagePath({
      source: '../shared/logo.png',
      filePath: 'docs/readme.md',
      directory: '/Users/rek/project',
    })).toBe('/Users/rek/project/shared/logo.png');
  });

  test('rejects images that escape the workspace', () => {
    expect(resolveLocalPreviewImagePath({
      source: '../../../etc/logo.png',
      filePath: 'docs/readme.md',
      directory: '/Users/rek/project',
    })).toBe('');
    expect(resolveLocalPreviewImagePath({
      source: '/etc/logo.png',
      filePath: 'readme.md',
      directory: '/Users/rek/project',
    })).toBe('');
    expect(resolveLocalPreviewImagePath({
      source: './logo.png',
      filePath: '',
      directory: '/Users/rek/project',
    })).toBe('');
  });
});

describe('markdown preview image scan', () => {
  test('rewrites embedded local images and stamps states idempotently', async () => {
    const container = createElement();
    container.innerHTML = '<img src="./assets/pic.svg"><img src="https://example.test/x.png"><img src="./docs/readme.md">';
    const fetched: string[] = [];
    const inflight = new Map<string, Promise<string | null>>();
    await resolveMarkdownPreviewImages(
      container,
      { filePath: 'docs/readme.md', directory: '/Users/rek/project' },
      async (imagePath) => {
        fetched.push(imagePath);
        expect(imagePath).toBe('/Users/rek/project/docs/assets/pic.svg');
        return 'data:image/svg+xml;base64,AAAA';
      },
      inflight,
    );
    const [embedded, remote, nonImage] = [...container.querySelectorAll('img')];
    expect(embedded.getAttribute('src')).toBe('data:image/svg+xml;base64,AAAA');
    expect(embedded.getAttribute('data-md-preview-image')).toBe('resolved');
    expect(remote.getAttribute('data-md-preview-image')).toBe('outside');
    expect(nonImage.getAttribute('data-md-preview-image')).toBe('outside');

    // A second pass leaves stamped images alone, so morph churn cannot loop.
    let rescans = 0;
    await resolveMarkdownPreviewImages(
      container,
      { filePath: 'docs/readme.md', directory: '/Users/rek/project' },
      async () => {
        rescans += 1;
        return '';
      },
      inflight,
    );
    expect(rescans).toBe(0);
  });

  test('deduplicates same-path requests and stamps failures without retrying', async () => {
    const container = createElement();
    container.innerHTML = '<img src="a.png"><img src="./a.png"><img src="b.png">';
    let fetches = 0;
    await resolveMarkdownPreviewImages(
      container,
      { filePath: 'readme.md', directory: '/Users/rek/project' },
      async () => {
        fetches += 1;
        throw new Error('bad image');
      },
      new Map(),
    );
    expect(fetches).toBe(2);
    for (const image of container.querySelectorAll('img')) {
      expect(image.getAttribute('data-md-preview-image')).toBe('failed');
    }
  });
});
