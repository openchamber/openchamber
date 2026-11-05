import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

Object.assign(globalThis, { DOMParser: new Window().DOMParser });

const { cleanDocumentHtml, isOpenableLink, officeFrameDocument } = await import('./officeFrame');

describe('office document frame', () => {
  test('drops what acts and keeps what the document looks like', () => {
    const html = cleanDocumentHtml(`
      <p style="color:red" onclick="steal()">Text</p>
      <script>steal()</script>
      <iframe src="https://evil.example"></iframe>
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <svg><use href="https://evil.example/a.svg#x"></use><animate attributeName="href"></animate></svg>
      <img src="https://evil.example/pixel.png">
      <img src="data:image/png;base64,AAAA">
    `);
    expect(html).toContain('style="color:red"');
    expect(html).toContain('Text');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('steal');
    expect(html).not.toContain('animate');
  });

  test('a link outside the file stops being a link and shows where it pointed', () => {
    const html = cleanDocumentHtml('<a href="javascript:alert(1)">bad</a><a href="https://example.com/x">web</a><a href="#part-2">inside</a>');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain(' href="https');
    expect(html).toContain('title="https://example.com/x"');
    expect(html).toContain('href="#part-2"');
  });

  test('the page has no way out', () => {
    const page = officeFrameDocument('<p>Text</p>', 'p{color:red}</style><script>steal()</script>');
    expect(page).toContain(`default-src 'none'`);
    const nonce = page.match(/nonce-([0-9a-f-]+)/)?.[1];
    expect(page).toContain(`<script nonce="${nonce}">`);
    // The closing tag in the file's styles stays text inside the style element.
    expect(page).not.toContain('</style><script>steal');
  });
});

describe('links in a document', () => {
  test('only an address a browser should open reaches the app', () => {
    const html = cleanDocumentHtml('<a href="https://a.dev/x">web</a><a href="mailto:a@b.dev">mail</a><a href="javascript:alert(1)">bad</a><a href="file:///etc/passwd">file</a>');
    expect(html).toContain('data-oc-href="https://a.dev/x"');
    expect(html).toContain('data-oc-href="mailto:a@b.dev"');
    expect(html).not.toContain('data-oc-href="javascript');
    expect(html).not.toContain('data-oc-href="file');
    expect(isOpenableLink('JAVASCRIPT:alert(1)')).toBe(false);
  });
});
