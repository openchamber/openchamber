import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  buildClickScript,
  buildInspectScript,
  buildScrollScript,
  buildSelectScript,
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
    expect(parses(buildSelectScript({ selector: '#country', label: 'Canada' }))).toBe(true);
    expect(parses(buildSelectScript({ selector: '#country', value: 'ca' }))).toBe(true);
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

  test('a select criterion is embedded as data too', () => {
    const selector = `'); window.__owned = true; ('`;
    const label = `"); window.__owned = true; ("`;
    const value = `\\'); window.__owned = true; ('`;

    for (const script of [
      buildSelectScript({ selector, label }),
      buildSelectScript({ selector, value }),
    ]) {
      expect(parses(script)).toBe(true);
      expect(script).toContain(JSON.stringify(selector));
    }
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

  test('snapshots native select options in live DOM order with state metadata', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <select id="country">
        <option value="us">
          United
          States
        </option>
        <optgroup label="Disabled group" disabled>
          <option value="grouped">グループ\noption</option>
        </optgroup>
        <option value="direct" disabled>Direct disabled</option>
        <option value="" selected>Empty value</option>
        <option value="us">Duplicate value</option>
      </select>`;
    const select = win.document.querySelector('#country');
    if (!(select instanceof win.HTMLSelectElement)) throw new Error('test select was not created');
    select.setAttribute('style', 'opacity: 1');
    Object.defineProperty(select, 'getBoundingClientRect', {
      value: () => ({ x: 16, y: 20, width: 240, height: 32, top: 20, right: 256, bottom: 52, left: 16 }),
    });
    select.options[0]!.selected = true;

    const result = JSON.parse(runInWindow(win, buildSnapshotScript()));
    const entry = result.elements.find((element: { selector: string }) => element.selector === '#country');

    expect(entry).toMatchObject({
      selector: '#country',
      tag: 'select',
      multiple: false,
      options: [
        { label: 'United States', value: 'us', selected: true, disabled: false },
        { label: 'グループ option', value: 'grouped', selected: false, disabled: true },
        { label: 'Direct disabled', value: 'direct', selected: false, disabled: true },
        { label: 'Empty value', value: '', selected: false, disabled: false },
        { label: 'Duplicate value', value: 'us', selected: false, disabled: false },
      ],
    });
    expect(entry.optionsTruncated).toBeUndefined();

    const snapshotLabel = entry.options[0].label;
    const selectResult = JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', label: snapshotLabel })));
    expect(selectResult).toMatchObject({ ok: true, label: snapshotLabel, value: 'us' });
  });

  test('snapshots multiple selects and reports bounded option truncation', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    const select = win.document.createElement('select');
    select.id = 'many';
    select.multiple = true;
    for (let index = 0; index < 33; index += 1) {
      const option = win.document.createElement('option');
      option.value = index === 0 ? `${'value'.repeat(30)}🙂` : `value-${index}`;
      option.textContent = index === 0 ? `${'label'.repeat(30)}🙂` : `Option ${index}`;
      select.append(option);
    }
    win.document.body.append(select);
    select.setAttribute('style', 'opacity: 1');
    Object.defineProperty(select, 'getBoundingClientRect', {
      value: () => ({ x: 16, y: 20, width: 240, height: 32, top: 20, right: 256, bottom: 52, left: 16 }),
    });
    select.options[0]!.selected = true;
    select.options[32]!.selected = true;

    const result = JSON.parse(runInWindow(win, buildSnapshotScript()));
    const entry = result.elements.find((element: { selector: string }) => element.selector === '#many');

    expect(entry.multiple).toBe(true);
    expect(entry.options).toHaveLength(32);
    expect(entry.options[0]).toMatchObject({
      value: 'value'.repeat(16),
      label: 'label'.repeat(16),
      selected: true,
      disabled: false,
    });
    expect(entry.options.at(-1)).toMatchObject({ value: 'value-31', selected: false });
    expect(entry.optionsTruncated).toBe(true);
    // The selected option beyond the cap is not promoted into the returned prefix.
    expect(entry.options.some((option: { value: string; selected: boolean }) => option.value === 'value-32' && option.selected)).toBe(false);
  });

  test('keeps non-select snapshot entries free of select-only fields', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = '<button id="save">Save</button>';
    const button = win.document.querySelector('#save');
    if (!button) throw new Error('test button was not created');
    button.setAttribute('style', 'opacity: 1');
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => ({ x: 16, y: 20, width: 80, height: 32, top: 20, right: 96, bottom: 52, left: 16 }),
    });

    const result = JSON.parse(runInWindow(win, buildSnapshotScript()));
    const entry = result.elements.find((element: { selector: string }) => element.selector === '#save');

    expect(entry).toEqual({
      selector: '#save',
      tag: 'button',
      bounds: { x: 16, y: 20, width: 80, height: 32 },
      inViewport: true,
      label: 'Save',
    });
  });

  test('handles an empty select and an invalid snapshot scope', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = '<select id="empty"></select>';
    const select = win.document.querySelector('#empty');
    if (!(select instanceof win.HTMLSelectElement)) throw new Error('test select was not created');
    select.setAttribute('style', 'opacity: 1');
    Object.defineProperty(select, 'getBoundingClientRect', {
      value: () => ({ x: 16, y: 20, width: 240, height: 32, top: 20, right: 256, bottom: 52, left: 16 }),
    });

    const result = JSON.parse(runInWindow(win, buildSnapshotScript()));
    const entry = result.elements.find((element: { selector: string }) => element.selector === '#empty');
    expect(entry).toMatchObject({ multiple: false, options: [] });
    expect(entry.optionsTruncated).toBeUndefined();
    expect(JSON.parse(runInWindow(win, buildSnapshotScript({ selector: '[' })))).toEqual({
      ok: false,
      error: 'Invalid selector: [',
    });
  });

  test('keeps hostile option strings as page data', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    const select = win.document.createElement('select');
    select.id = 'safe';
    const hostile = `"); window.__owned = true; ("`;
    const option = win.document.createElement('option');
    option.value = hostile;
    option.textContent = hostile;
    select.append(option);
    win.document.body.append(select);
    select.setAttribute('style', 'opacity: 1');
    Object.defineProperty(select, 'getBoundingClientRect', {
      value: () => ({ x: 16, y: 20, width: 240, height: 32, top: 20, right: 256, bottom: 52, left: 16 }),
    });

    const result = JSON.parse(runInWindow(win, buildSnapshotScript()));
    const entry = result.elements.find((element: { selector: string }) => element.selector === '#safe');

    expect(entry.options).toEqual([{ label: hostile, value: hostile, selected: true, disabled: false }]);
    expect((win as Window & { __owned?: boolean }).__owned).toBeUndefined();
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

  test('selects a native option by its exact visible label and delivers events', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <select id="country">
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>`;
    const seen: string[] = [];
    const select = win.document.querySelector('#country');
    if (!(select instanceof win.HTMLSelectElement)) throw new Error('test select was not created');
    select?.addEventListener('input', () => seen.push('input'));
    select?.addEventListener('change', () => seen.push('change'));

    const result = JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', label: 'Canada' })));

    expect(result).toEqual({ ok: true, selector: '#country', label: 'Canada', value: 'ca', url: 'http://localhost:3000/' });
    expect(select?.value).toBe('ca');
    expect(select?.selectedOptions[0]?.textContent).toBe('Canada');
    expect(seen).toEqual(['input', 'change']);
  });

  test('selects an option by exact value and reports the selected label', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <select id="country">
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>`;

    const result = JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', value: 'ca' })));

    expect(result).toMatchObject({ ok: true, selector: '#country', label: 'Canada', value: 'ca' });
    const select = win.document.querySelector('#country');
    if (!(select instanceof win.HTMLSelectElement)) throw new Error('test select was not created');
    expect(select.value).toBe('ca');
  });

  test('normalizes whitespace when matching an option label', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <select id="country">
        <option value="ca">\n          Canada\n        </option>
      </select>`;

    const result = JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', label: 'Canada' })));

    expect(result).toMatchObject({ ok: true, label: 'Canada', value: 'ca' });
  });

  test('rejects missing, conflicting, invalid, and ambiguous selection inputs', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <select id="country">
        <option value="ca">Canada</option>
        <option value="ca">Canada</option>
      </select>`;

    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country' })))).toEqual({
      ok: false,
      error: 'browser.select requires exactly one of label or value',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', label: 'Canada', value: 'ca' })))).toEqual({
      ok: false,
      error: 'browser.select requires exactly one of label or value',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', label: 'Missing' })))).toEqual({
      ok: false,
      error: 'No option in #country has the exact label Missing',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', label: 'Canada' })))).toEqual({
      ok: false,
      error: 'More than one option in #country has the exact label Canada',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', value: 'ca' })))).toEqual({
      ok: false,
      error: 'More than one option in #country has the exact value ca',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '[', value: 'ca' })))).toEqual({
      ok: false,
      error: 'Invalid selector: [',
    });
  });

  test('rejects custom controls, disabled options, disabled selects, and multiple selects', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <div id="custom" role="listbox"><div role="option">Canada</div></div>
      <select id="disabled-option"><option value="ca" disabled>Canada</option></select>
      <select id="disabled-select" disabled><option value="ca">Canada</option></select>
      <select id="multiple" multiple><option value="ca">Canada</option></select>`;

    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#custom', label: 'Canada' })))).toEqual({
      ok: false,
      error: '#custom is not a native HTML select',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#disabled-option', label: 'Canada' })))).toEqual({
      ok: false,
      error: 'The matching option in #disabled-option is disabled',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#disabled-select', value: 'ca' })))).toEqual({
      ok: false,
      error: 'The select #disabled-select is disabled',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#multiple', value: 'ca' })))).toEqual({
      ok: false,
      error: 'Multiple selects are not supported for browser.select',
    });
  });

  test('refuses an option inside a disabled optgroup and still selects its enabled siblings', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    win.document.body.innerHTML = `
      <select id="country">
        <optgroup label="Europe" disabled><option value="de">Germany</option></optgroup>
        <optgroup label="Americas"><option value="ca">Canada</option></optgroup>
      </select>`;

    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', value: 'de' })))).toEqual({
      ok: false,
      error: 'The matching option in #country is disabled',
    });
    expect(JSON.parse(runInWindow(win, buildSelectScript({ selector: '#country', value: 'ca' })))).toMatchObject({
      ok: true,
      label: 'Canada',
      value: 'ca',
    });
  });

  test('keeps hostile selector, label, and value strings inert', () => {
    const win = new Window({ url: 'http://localhost:3000/' });
    const hostile = `"); window.__owned = true; ("`;
    const select = win.document.createElement('select');
    select.id = 'safe';
    const option = win.document.createElement('option');
    option.value = hostile;
    option.textContent = hostile;
    select.append(option);
    win.document.body.append(select);

    const result = JSON.parse(runInWindow(win, buildSelectScript({ selector: '#safe', value: hostile })));

    expect(result).toMatchObject({ ok: true, label: hostile, value: hostile });
    expect((win as Window & { __owned?: boolean }).__owned).toBeUndefined();
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
