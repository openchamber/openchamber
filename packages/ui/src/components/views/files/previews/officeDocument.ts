import { extractDocumentAttachments } from '@/sync/document-attachments';
import { getFileExtension } from '@/lib/toolHelpers';
import { officeFrameDocument } from './officeFrame';
import { openWorkbook, type WorkbookBook } from './documentClient';

export type OfficePreview =
  | { kind: 'page'; html: string; slideCount: number | null }
  | { kind: 'workbook'; book: WorkbookBook; bytes: Uint8Array<ArrayBuffer> };

const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const dataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const renderDocx = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const { renderAsync } = await import('docx-preview');
  // Built in a document with no browsing context, so nothing in it loads or runs.
  const inert = document.implementation.createHTMLDocument('');
  const body = inert.createElement('div');
  const styles = inert.createElement('div');
  await renderAsync(bytes.buffer, body, styles, { useBase64URL: true, renderAltChunks: false });
  return officeFrameDocument(body.innerHTML, styles.textContent ?? '');
};

const renderPptx = async (bytes: Uint8Array<ArrayBuffer>): Promise<OfficePreview> => {
  const { pptxToHtml } = await import('@jvmr/pptx-to-html');
  const slides = await pptxToHtml(bytes.buffer);
  return { kind: 'page', html: officeFrameDocument(slides.join('')), slideCount: slides.length };
};

/** ODF has no renderer: its text and images, from the same reader chat attachments use. */
const renderOdf = async (file: File): Promise<string | null> => {
  const extracted = await extractDocumentAttachments(file);
  if (!extracted) return null;
  const images = new Map(await Promise.all(extracted.images.map(async (image) => [image.name, await dataUrl(image)] as const)));
  const blocks = (await extracted.textFile.text()).split(/\n{2,}/).slice(1).map((block) => {
    const image = images.get(block.match(/^\[(.+)\]$/)?.[1] ?? '');
    if (image) return `<img src="${image}" alt="">`;
    if (block.startsWith('## ')) return `<h2>${escapeHtml(block.slice(3))}</h2>`;
    return `<p>${escapeHtml(block)}</p>`;
  });
  return officeFrameDocument(`<div class="oc-page">${blocks.join('')}</div>`);
};

/** Throws on a file that is not the document its name says, such as a damaged or password-protected one. */
export const readOfficePreview = async (name: string, path: string, bytes: Uint8Array<ArrayBuffer>): Promise<OfficePreview | null> => {
  const file = new File([bytes], name);
  switch (getFileExtension(name)) {
    case 'docx':
      return { kind: 'page', html: await renderDocx(bytes), slideCount: null };
    case 'pptx':
      return renderPptx(bytes);
    case 'xlsx':
    case 'ods': {
      const book = await openWorkbook(path, name, bytes);
      return book ? { kind: 'workbook', book, bytes } : null;
    }
    case 'odt':
    case 'odp': {
      const html = await renderOdf(file);
      return html === null ? null : { kind: 'page', html, slideCount: null };
    }
    default:
      return null;
  }
};
