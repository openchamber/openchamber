import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  buildClickScript,
  buildInspectScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
} from './pageActions';

/**
 * These scripts are source text evaluated inside another page: nothing
 * type-checks them, and a value interpolated without escaping either breaks the
 * script or runs as code.
 */
const parses = (source: string): boolean => {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
};

const runInWindow = (win: Window, source: string): string => (
  JSON.stringify(new Function('window', 'document', 'navigator', 'CSS', 'location', `return ${source}`)(
    win,
    win.document,
    win.navigator,
    win.CSS,
    win.location,
  ))
);

describe('page action scripts', () => {
  test('every script parses', () => {
    expect(parses(buildSnapshotScript())).toBe(true);
    expect(parses(buildSnapshotScript({ selector: '#main' }))).toBe(true);
    expect(parses(buildClickScript({ selector: '#save' }))).toBe(true);
    expect(parses(buildClickScript({ text: 'Save' }))).toBe(true);
    expect(parses(buildTypeScript({ selector: '#q', value: 'hello', submit: true }))).toBe(true);
    expect(parses(buildInspectScript({ selector: '#save' }))).toBe(true);
    expect(parses(buildScrollScript({ direction: 'bottom' }))).toBe(true);
    expect(parses(buildScrollScript({ selector: 'footer' }))).toBe(true);
  });

  test('a hostile selector is embedded as data, not as code', () => {
    const hostile = `'); window.__owned = true; ('`;
    const script = buildClickScript({ selector: hostile });
    expect(parses(script)).toBe(true);
    // Present only inside a quoted literal: that is what makes it inert.
    expect(script).toContain(JSON.stringify(hostile));
  });

  test('a typed value is embedded as data too', () => {
    const value = '"); alert(1); ("';
    const script = buildTypeScript({ selector: '#q', value, submit: false });
    expect(parses(script)).toBe(true);
    expect(script).toContain(JSON.stringify(value));
  });

  test('whitespace regexes survive interpolation', () => {
    // A doubled backslash here would produce a literal backslash-s and match
    // nothing, silently collapsing no whitespace at all.
    expect(buildSnapshotScript()).toContain('replace(/\\s+/g');
  });

  test('scrolling asks for instant behaviour, not the page preference', () => {
    // A page with scroll-behavior: smooth would otherwise still be animating
    // when the position is read.
    expect(buildScrollScript({ direction: 'bottom' })).toContain("behavior: 'instant'");
    expect(buildScrollScript({ selector: 'footer' })).toContain("behavior: 'instant'");
  });

  test('a scoped snapshot reads only the subtree it was given', () => {
    const script = buildSnapshotScript({ selector: '#changelog' });
    expect(script).toContain('"#changelog"');
    expect(script).toContain('root.querySelectorAll');
  });

  test('copies and pastes through the browser clipboard in one tab', async () => {
    const fixture = 'test_secret_not_real_123';
    let clipboard = '';
    const win = new Window({ url: 'http://localhost:3000/' });
    Object.defineProperty(win.navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => { clipboard = value; },
        readText: async () => clipboard,
      },
    });
    win.document.body.innerHTML = '<button id="copy">Copy API key</button><button id="paste">Paste</button><input id="target">';
    win.document.querySelector('#copy')?.addEventListener('click', () => {
      void win.navigator.clipboard.writeText(fixture);
    });
    win.document.querySelector('#paste')?.addEventListener('click', () => {
      void win.navigator.clipboard.readText().then((value) => {
        const target = win.document.querySelector('input');
        if (target) target.value = value;
      });
    });

    const copyResult = runInWindow(win, buildClickScript({ selector: '#copy' }));
    runInWindow(win, buildClickScript({ selector: '#paste' }));
    await Promise.resolve();

    expect(win.document.querySelector('input')?.value).toBe(fixture);
    expect(copyResult).not.toContain(fixture);
  });

  test('copies in one tab and pastes in another without serializing the value', async () => {
    const fixture = 'test_secret_not_real_123';
    let clipboard = '';
    const source = new Window({ url: 'https://example.test/account' });
    const destination = new Window({ url: 'http://localhost:3000/' });
    Object.defineProperty(source.navigator, 'clipboard', {
      value: { writeText: async (value: string) => { clipboard = value; } },
    });
    Object.defineProperty(destination.navigator, 'clipboard', {
      value: { readText: async () => clipboard },
    });
    source.document.body.innerHTML = '<button id="copy">Copy API key</button>';
    destination.document.body.innerHTML = '<button id="paste">Paste</button><input id="target">';
    source.document.querySelector('#copy')?.addEventListener('click', () => {
      void source.navigator.clipboard.writeText(fixture);
    });
    destination.document.querySelector('#paste')?.addEventListener('click', () => {
      void destination.navigator.clipboard.readText().then((value) => {
        const target = destination.document.querySelector('input');
        if (target) target.value = value;
      });
    });

    const copyResult = runInWindow(source, buildClickScript({ selector: '#copy' }));
    const pasteResult = runInWindow(destination, buildClickScript({ selector: '#paste' }));
    await Promise.resolve();

    expect(destination.document.querySelector('input')?.value).toBe(fixture);
    expect(copyResult).not.toContain(fixture);
    expect(pasteResult).not.toContain(fixture);
    expect(runInWindow(destination, buildSnapshotScript())).not.toContain(fixture);
  });
});
