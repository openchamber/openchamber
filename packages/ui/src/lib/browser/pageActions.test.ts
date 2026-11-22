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

  test('typing refuses a non-text input a generic selector resolves to', () => {
    // Issue #32: on DuckDuckGo, selector 'input' resolved to the checkbox
    // #sidemenu-toggle and browser.type reported success, while a button
    // selector was refused as not a text field. The check is the input type,
    // not the tag name.
    const win = new Window({ url: 'https://duckduckgo.com/' });
    win.document.body.innerHTML = '<input type="checkbox" id="sidemenu-toggle"><input type="text" id="search">';
    const runType = new Function(
      'window', 'document', 'navigator', 'CSS', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
      `return ${buildTypeScript({ selector: 'input', value: 'hello', submit: false })}`,
    );
    const result = runType(win, win.document, win.navigator, win.CSS, win.location, win.HTMLInputElement, win.HTMLTextAreaElement, win.Event);
    expect(JSON.stringify(result)).toBe('{"ok":false,"error":"input is not a text field"}');
    expect(win.document.querySelector('input')?.checked).toBe(false);
  });

  test('typing refuses button-like and hidden inputs but accepts text-like ones', () => {
    const win = new Window({ url: 'https://example.test/' });
    const runType = (selector: string, typed = 'hello'): string => JSON.stringify(new Function(
      'window', 'document', 'navigator', 'CSS', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
      `return ${buildTypeScript({ selector, value: typed, submit: false })}`,
    )(win, win.document, win.navigator, win.CSS, win.location, win.HTMLInputElement, win.HTMLTextAreaElement, win.Event));

    for (const type of ['submit', 'button', 'radio', 'hidden', 'file']) {
      win.document.body.innerHTML = `<input type="${type}" id="field">`;
      expect(runType('#field')).toBe('{"ok":false,"error":"#field is not a text field"}');
    }
    for (const type of ['text', 'search', 'email', 'password', 'tel', 'url']) {
      win.document.body.innerHTML = `<input type="${type}" id="field">`;
      expect(runType('#field')).toContain('"ok":true');
      expect(win.document.querySelector('input')?.value).toBe('hello');
    }
    // A number field is text-like too, and keeps a numeric value.
    win.document.body.innerHTML = '<input type="number" id="field">';
    expect(runType('#field', '42')).toContain('"ok":true');
    expect(win.document.querySelector('input')?.value).toBe('42');
    // No type attribute reads back as 'text', in the page and to the user.
    win.document.body.innerHTML = '<input id="field">';
    expect(runType('#field')).toContain('"ok":true');

    win.document.body.innerHTML = '<textarea id="field"></textarea>';
    expect(runType('#field')).toContain('"ok":true');
    expect(win.document.querySelector('textarea')?.value).toBe('hello');
  });

  test('typing reports failure when the field rejects the value', () => {
    // Issue #68: a number field handed letters ends up empty, as it does for
    // a person typing them, but the type script reported success anyway —
    // the agent then acts on a value that never landed.
    const win = new Window({ url: 'https://example.test/' });
    win.document.body.innerHTML = '<input type="number" id="field">';
    const runType = new Function(
      'window', 'document', 'navigator', 'CSS', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
      `return ${buildTypeScript({ selector: '#field', value: 'hello', submit: false })}`,
    );
    const result = runType(win, win.document, win.navigator, win.CSS, win.location, win.HTMLInputElement, win.HTMLTextAreaElement, win.Event);
    expect(JSON.stringify(result)).toContain('"ok":false');
    expect(JSON.stringify(result)).toContain('did not keep the typed value');
    expect(win.document.querySelector('input')?.value).toBe('');
  });

  test('a password field mismatch error never contains the held or typed secret', () => {
    // Issue #1073 (Codex P1 on PR #70): the mismatch error embedded the
    // field's held value verbatim, so a controlled password field whose
    // handler restores its value handed the secret to the calling agent.
    const win = new Window({ url: 'https://example.test/' });
    win.document.body.innerHTML = '<input type="password" id="field">';
    const input = win.document.querySelector('input');
    if (!input) throw new Error('password input missing');
    const heldSecret = 'held-secret-value';
    input.value = heldSecret;
    input.addEventListener('input', () => { input.value = heldSecret; });
    input.addEventListener('change', () => { input.value = heldSecret; });
    const runType = new Function(
      'window', 'document', 'navigator', 'CSS', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
      `return ${buildTypeScript({ selector: '#field', value: 'typed-secret-attempt', submit: false })}`,
    );
    const result = runType(win, win.document, win.navigator, win.CSS, win.location, win.HTMLInputElement, win.HTMLTextAreaElement, win.Event);
    const rendered = JSON.stringify(result);
    expect(rendered).toContain('"ok":false');
    expect(rendered).toContain('did not keep the typed value');
    expect(rendered).not.toContain(heldSecret);
    expect(rendered).not.toContain('typed-secret-attempt');
    expect(rendered).not.toContain('character');
    expect(input.value).toBe(heldSecret);
  });

  test('a revealed password field mismatch error carries no character count', () => {
    // CodeRabbit on PR #1087: a visibility toggle flips type to text while
    // autocomplete="current-password" still names the secret — the count is
    // a diagnostic derived from the secret's content and must be suppressed.
    const win = new Window({ url: 'https://example.test/' });
    win.document.body.innerHTML = '<input type="text" autocomplete="current-password" id="field">';
    const input = win.document.querySelector('input');
    if (!input) throw new Error('revealed password input missing');
    const heldSecret = 'revealed-secret';
    input.value = heldSecret;
    input.addEventListener('input', () => { input.value = heldSecret; });
    input.addEventListener('change', () => { input.value = heldSecret; });
    const runType = new Function(
      'window', 'document', 'navigator', 'CSS', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
      `return ${buildTypeScript({ selector: '#field', value: 'another-attempt', submit: false })}`,
    );
    const result = runType(win, win.document, win.navigator, win.CSS, win.location, win.HTMLInputElement, win.HTMLTextAreaElement, win.Event);
    const rendered = JSON.stringify(result);
    expect(rendered).toContain('"ok":false');
    expect(rendered).toContain('did not keep the typed value');
    expect(rendered).not.toContain(heldSecret);
    expect(rendered).not.toContain('character');
  });

  test('a contenteditable field turned non-editable by its handler still reports the mismatch', () => {
    // CodeRabbit on PR #1087: the readback must use the editing kind captured
    // before dispatch — reading .value off a div whose editability flipped
    // mid-event is undefined and must not throw instead of reporting.
    const win = new Window({ url: 'https://example.test/' });
    win.document.body.innerHTML = '<div contenteditable="true" id="field">old text</div>';
    const div = win.document.querySelector('div');
    if (!div) throw new Error('contenteditable div missing');
    div.addEventListener('input', () => { div.textContent = 'old text'; div.contentEditable = 'false'; });
    div.addEventListener('change', () => { div.textContent = 'old text'; });
    const runType = new Function(
      'window', 'document', 'navigator', 'CSS', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
      `return ${buildTypeScript({ selector: '#field', value: 'typed replacement', submit: false })}`,
    );
    const result = runType(win, win.document, win.navigator, win.CSS, win.location, win.HTMLInputElement, win.HTMLTextAreaElement, win.Event);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('did not keep the typed value');
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

  test('scrolling answers on a page that gets no paint frames', async () => {
    // A background tab is not composited, so its requestAnimationFrame never
    // fires. Waiting on frames alone left the action hanging until it timed out.
    const win = new Window({ url: 'https://example.test/' });
    const noFrames = (): number => 0;
    const run = new Function(
      'window', 'document', 'location', 'CSS', 'requestAnimationFrame', 'setTimeout',
      `return ${buildScrollScript({ direction: 'down' })}`,
    );
    const answer = Promise.resolve(run(win, win.document, win.location, win.CSS, noFrames, setTimeout));
    const hung = new Promise((resolve) => setTimeout(() => resolve('hung'), 1_000));
    const result = await Promise.race([answer, hung]);
    expect(result).toMatchObject({ ok: true, direction: 'down' });
    await win.happyDOM.close();
  });

  test('a scoped snapshot reads only the subtree it was given', () => {
    const script = buildSnapshotScript({ selector: '#changelog' });
    expect(script).toContain('"#changelog"');
    expect(script).toContain('root.querySelectorAll');
  });

  test('a click opens a widget that listens for mousedown or focus', () => {
    // VueMultiselect and many custom selects open on the first half of a
    // click; a bare click event reported success while they stayed shut.
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <div id="by-mousedown"><span class="placeholder">Add a monitor</span></div>
      <div id="by-focus" tabindex="-1">Pick one</div>`;
    const opened: string[] = [];
    win.document.querySelector('#by-mousedown')?.addEventListener('mousedown', () => opened.push('mousedown'));
    win.document.querySelector('#by-focus')?.addEventListener('focus', () => opened.push('focus'));

    expect(runInWindow(win, buildClickScript({ selector: '#by-mousedown' }))).toContain('"ok":true');
    expect(runInWindow(win, buildClickScript({ selector: '#by-focus' }))).toContain('"ok":true');

    expect(opened).toEqual(['mousedown', 'focus']);
  });

  test('a click sends the sequence a mouse sends, once each', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = '<button id="save">Save</button>';
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
      win.document.querySelector('#save')?.addEventListener(type, () => seen.push(type));
    }

    runInWindow(win, buildClickScript({ selector: '#save' }));

    expect(seen).toEqual(['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']);
  });

  test('a page that prevents mousedown keeps its focus where it was', () => {
    // Dropdown options do this so picking one does not blur the search field.
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = '<input id="search"><div id="option" tabindex="-1">Website</div>';
    const search = win.document.querySelector('input');
    search?.focus();
    win.document.querySelector('#option')?.addEventListener('mousedown', (event) => event.preventDefault());

    runInWindow(win, buildClickScript({ selector: '#option' }));

    expect(win.document.activeElement).toBe(search);
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
