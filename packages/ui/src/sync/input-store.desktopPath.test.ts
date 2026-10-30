import { afterAll, expect, mock, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { attachmentBasename, attachmentWireName } from '@/lib/attachmentIdentity';

mock.module('heic2any', () => ({
  default: async () => new Blob(['jpeg-data'], { type: 'image/jpeg' }),
}));

/**
 * A dropped file's on-disk path reaches the attachment, so the model is handed
 * the file's location instead of a bare basename. This lives in its own file:
 * it installs the desktop globals the intake gate reads, which would leak into
 * the store's other cases if they shared a process.
 */

// The store installs its `onload` as a closure over the reader, never as a
// `this`-bound handler, so the stub only needs the no-argument shape.
class ImmediateFileReader {
  result: string | ArrayBuffer | null = 'data:text/plain;base64,aGVsbG8=';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  readAsDataURL() {
    queueMicrotask(() => { this.onload?.(); });
  }
}

const origin = 'http://127.0.0.1:3901';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousFileReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
    __OPENCHAMBER_LOCAL_ORIGIN__: origin,
    __OPENCHAMBER_API_BASE_URL__: origin,
    __OPENCHAMBER_DESKTOP__: {
      invoke: async () => null,
      // Stands in for Electron's `webUtils.getPathForFile`.
      pathForFile: (file: File) => `/Users/me/Documents/${file.name}`,
    },
  },
});
Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: ImmediateFileReader });

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (previousFileReader) Object.defineProperty(globalThis, 'FileReader', previousFileReader);
  else Reflect.deleteProperty(globalThis, 'FileReader');
});

test('a desktop-dropped file carries its on-disk path while the chip label stays the basename', async () => {
  const { useInputStore } = await import('./input-store');

  const attached = await useInputStore.getState().addAttachedFile(
    new File(['hello'], 'report.txt', { type: 'text/plain' }),
  );

  expect(attached).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file?.filename).toBe('report.txt');
  expect(file?.agentPath).toBe('/Users/me/Documents/report.txt');
});

for (const [wireName, basename] of [
  ['/Users/me/Documents/report.txt', 'report.txt'],
  ['C:\\Users\\me\\report.txt', 'report.txt'],
  ['/Users/me/Documents/photo.heic', 'photo.heic'],
  ['weird\\name.txt', 'weird\\name.txt'],
  ['report.txt', 'report.txt'],
]) {
  test(`restoring ${wireName} keeps its citation name and resend identity`, async () => {
    const { useInputStore } = await import('./input-store');
    const { findAttachmentCitationRanges } = await import('@/components/chat/attachmentCitations');
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    store.addRestoredAttachment({ url: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain', filename: wireName });

    const [restored] = useInputStore.getState().attachedFiles;
    expect(restored.filename).toBe(basename);
    expect(restored.file?.name).toBe(basename);
    expect(attachmentWireName(restored)).toBe(wireName);
    expect(findAttachmentCitationRanges(`[${basename}]`, [restored.filename])).toHaveLength(1);
  });
}

test('a content-transformed attachment does not carry the path to the unsanitized original', async () => {
  const { useInputStore } = await import('./input-store');
  useInputStore.getState().clearAttachedFiles();

  const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'authorization', value: 'Bearer secret' }] } }] } });
  const attached = await useInputStore.getState().addAttachedFile(
    new File([har], 'capture.har', { type: 'application/json' }),
  );

  expect(attached).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file?.filename).toBe('capture.har');
  expect(file?.agentPath).toBeUndefined();
  expect(await file?.file?.text()).not.toContain('Bearer secret');
});

test('only the extracted document text carries the original path', async () => {
  const { prepareLocalAttachments } = await import('./input-store');
  const file = new File([zipSync({
    'word/document.xml': strToU8('<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p><w:p><a:blip r:embed="image"/></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="image" Target="media/chart.png" Type="image"/></Relationships>'),
    'word/media/chart.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })], 'report.docx');

  const attached = await prepareLocalAttachments(file);

  expect(attached).toHaveLength(2);
  expect(attached?.[0]?.agentPath).toBe('/Users/me/Documents/report.docx');
  expect(await attached?.[0]?.file?.text()).toContain('[report-image-1.png]');
  expect(attached?.[1]?.filename).toBe('report-image-1.png');
  expect(attached?.[1]?.agentPath).toBeUndefined();
});

test('notebooks with omitted outputs do not carry the original path', async () => {
  const { prepareLocalAttachments } = await import('./input-store');
  const notebook = { cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [
    { data: { 'image/png': 'binary-output' } },
  ] }] };
  const attached = await prepareLocalAttachments(new File([JSON.stringify(notebook)], 'analysis.IPYNB'));

  expect(attached).toHaveLength(1);
  expect(attached?.[0]?.agentPath).toBeUndefined();
  expect(await attached?.[0]?.file?.text()).not.toContain('binary-output');
});

for (const extension of ['heic', 'heif']) {
  test(`converted ${extension} keeps the original path and matching citation name`, async () => {
    const { prepareLocalAttachments } = await import('./input-store');
    const attached = await prepareLocalAttachments(new File(['heic-data'], `photo.${extension}`, { type: `image/${extension}` }));
    const file = attached?.[0];

    expect(file).toBeDefined();
    expect(file?.mimeType).toBe('image/jpeg');
    expect(await file?.file?.text()).toBe('jpeg-data');
    expect(file?.agentPath).toBe(`/Users/me/Documents/photo.${extension}`);
    expect(file?.filename).toBe(`photo.${extension}`);
    if (file) expect(attachmentBasename(attachmentWireName(file))).toBe(file.filename);
  });
}
