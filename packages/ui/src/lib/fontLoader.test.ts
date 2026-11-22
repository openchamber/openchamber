import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { loadedAppFontCSS, loadMonoFont, loadUiFont } from './fontLoader';

test('loads screen fonts without waiting for the export copy, and exports the loaded stacks as self-contained CSS', async () => {
  const browser = new Window();
  const { document, FontFace, FileReader, Response, Blob } = globalThis;
  const registeredFaces = new Set<unknown>();
  const startedFaces: unknown[] = [];
  Object.defineProperty(browser.document, 'fonts', { value: registeredFaces });
  Object.assign(globalThis, {
    document: browser.document,
    FontFace: class {
      async load() {
        if (registeredFaces.has(this)) startedFaces.push(this);
        return this;
      }
    },
    FileReader: browser.FileReader,
    Response: browser.Response,
    Blob: browser.Blob,
  });
  const requests: string[] = [];
  let releaseReads: () => void = () => {};
  const readsHeld = new Promise<void>((resolve) => { releaseReads = resolve; });
  let iosevkaRegularFails = true;
  const fetchFont = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    requests.push(url);
    await readsHeld;
    if (url.includes('iosevka-latin-500')) return new globalThis.Response(null, { status: 503 });
    if (url.includes('iosevka-latin-400') && iosevkaRegularFails) {
      iosevkaRegularFails = false;
      return new globalThis.Response(null, { status: 503 });
    }
    return new globalThis.Response(new globalThis.Blob(['font bytes'], { type: 'font/woff2' }));
  });

  try {
    // The export reads are still held: the screen faces finish anyway.
    await Promise.all([loadUiFont('inter'), loadMonoFont('iosevka'), loadMonoFont('cascadia-code')]);
    expect(startedFaces).toHaveLength(5);
    releaseReads();

    expect(await loadedAppFontCSS(['system-ui', 'ui-monospace'])).toBe('');

    // The first read of one face failed: that face is left out, never cached as empty.
    const first = await loadedAppFontCSS(['Inter, system-ui', '"Iosevka", Menlo, monospace']);
    expect(first.match(/font-family:"Iosevka";font-weight:(400|600);/g)).toHaveLength(1);

    // The next save reads it again and gets it.
    const css = await loadedAppFontCSS(['Inter, system-ui', '"Iosevka", Menlo, monospace']);
    expect(css.match(/font-family:"Inter";font-weight:100 900;/g)).toHaveLength(1);
    expect(css.match(/font-family:"Iosevka";font-weight:(400|600);/g)).toHaveLength(2);
    expect(css.match(/data:font\/woff2;base64,Zm9udCBieXRlcw==/g)).toHaveLength(3);
    expect(css).not.toContain('Cascadia Code');

    // A face still loading when Save starts is waited for, so the PNG uses the face the layout measured.
    let finishLoad: () => void = () => {};
    const slowFace = new Promise<void>((resolve) => { finishLoad = resolve; });
    Object.assign(globalThis, { FontFace: class { async load() { await slowFace; return this; } } });
    const loading = loadMonoFont('jetbrains-mono');
    const exporting = loadedAppFontCSS(['"JetBrains Mono", monospace']);
    finishLoad();
    await loading;
    expect(await exporting).toContain('font-family:"JetBrains Mono"');
  } finally {
    fetchFont.mockRestore();
    Object.assign(globalThis, { document, FontFace, FileReader, Response, Blob });
    await browser.happyDOM.abort();
  }
});
