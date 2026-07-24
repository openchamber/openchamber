import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ModelMetadata } from '@/types';

let metadataByKey: Record<string, ModelMetadata | undefined> = {};

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getModelMetadata: (providerId: string, modelId: string) => metadataByKey[`${providerId}/${modelId}`],
    }),
  },
}));

import { groundAttachmentsForModel, modelAcceptsAttachmentMime } from './attachmentGrounding';

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
let statExists = false;
let writeOk = true;

const installFetchStub = () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url.includes('/api/fs/stat')) {
      return new Response(statExists ? '{}' : 'missing', { status: statExists ? 200 : 404 });
    }
    if (url.includes('/api/fs/write')) {
      return new Response(writeOk ? '{"success":true}' : 'denied', { status: writeOk ? 200 : 403 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
};

const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const xlsxDataUrl = `data:${xlsxMime};base64,${Buffer.from('spreadsheet-bytes').toString('base64')}`;

beforeEach(() => {
  metadataByKey = {};
  fetchCalls = [];
  statExists = false;
  writeOk = true;
  installFetchStub();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('modelAcceptsAttachmentMime', () => {
  test('text/plain always passes', async () => {
    expect(await modelAcceptsAttachmentMime('text/plain', 'p', 'm')).toBe(true);
  });

  test('spreadsheets never pass regardless of metadata', async () => {
    metadataByKey['p/m'] = { modalities: { input: ['text', 'image', 'pdf'] } } as ModelMetadata;
    expect(await modelAcceptsAttachmentMime(xlsxMime, 'p', 'm')).toBe(false);
  });

  test('image passes only when the model declares image input', async () => {
    metadataByKey['p/vision'] = { modalities: { input: ['text', 'image'] } } as ModelMetadata;
    metadataByKey['p/textonly'] = { modalities: { input: ['text'] } } as ModelMetadata;
    expect(await modelAcceptsAttachmentMime('image/png', 'p', 'vision')).toBe(true);
    expect(await modelAcceptsAttachmentMime('image/png', 'p', 'textonly')).toBe(false);
  });

  test('falls back to the attachment flag when modalities are missing', async () => {
    metadataByKey['p/flagged'] = { attachment: true } as ModelMetadata;
    expect(await modelAcceptsAttachmentMime('application/pdf', 'p', 'flagged')).toBe(true);
    expect(await modelAcceptsAttachmentMime('application/pdf', 'p', 'unknown')).toBe(false);
  });
});

describe('groundAttachmentsForModel', () => {
  test('supported image goes direct, spreadsheet is grounded to uploads/', async () => {
    metadataByKey['p/vision'] = { modalities: { input: ['text', 'image'] } } as ModelMetadata;
    const image = { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,aGk=', filename: 'shot.png' };
    const sheet = { type: 'file' as const, mime: xlsxMime, url: xlsxDataUrl, filename: 'report.xlsx' };

    const result = await groundAttachmentsForModel({
      files: [image, sheet],
      providerID: 'p',
      modelID: 'vision',
      directory: '/repo',
    });

    expect(result.direct).toEqual([image]);
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toContain('uploads/report.xlsx');
    expect(result.hints[0]).toContain('report.xlsx');

    const write = fetchCalls.find((c) => c.url.includes('/api/fs/write'));
    expect(write).toBeDefined();
    const stat = fetchCalls.find((c) => c.url.includes('/api/fs/stat'));
    expect(stat?.url).toContain('directory=%2Frepo');
    const body = JSON.parse(String(write?.init?.body));
    expect(body.path).toBe('uploads/report.xlsx');
    expect(body.encoding).toBe('base64');
    expect(Buffer.from(body.content, 'base64').toString()).toBe('spreadsheet-bytes');
    expect(write?.url).toContain('directory=%2Frepo');
  });

  test('name collision picks a suffixed path', async () => {
    statExists = true;
    const sheet = { type: 'file' as const, mime: xlsxMime, url: xlsxDataUrl, filename: 'report.xlsx' };
    const result = await groundAttachmentsForModel({ files: [sheet], providerID: 'p', modelID: 'm', directory: '/repo' });
    expect(/uploads\/report-\d+\.xlsx/.test(result.hints[0])).toBe(true);
  });

  test('write failure falls back to sending the original file part', async () => {
    writeOk = false;
    const sheet = { type: 'file' as const, mime: xlsxMime, url: xlsxDataUrl, filename: 'report.xlsx' };
    const result = await groundAttachmentsForModel({ files: [sheet], providerID: 'p', modelID: 'm', directory: '/repo' });
    expect(result.direct).toEqual([sheet]);
    expect(result.hints).toHaveLength(0);
  });

  test('image hint tells the agent to suggest a vision-capable model', async () => {
    const img = { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,aGk=', filename: 'photo.png' };
    const result = await groundAttachmentsForModel({ files: [img], providerID: 'p', modelID: 'textonly', directory: '/repo' });
    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toContain('vision-capable model');
    expect(result.hints[0]).not.toContain('e.g. Python');
  });

  test('file:// attachments produce an on-disk hint without uploading', async () => {
    const sheet = { type: 'file' as const, mime: xlsxMime, url: 'file:///repo/data/report.xlsx', filename: 'report.xlsx' };
    const result = await groundAttachmentsForModel({ files: [sheet], providerID: 'p', modelID: 'm', directory: '/repo' });
    expect(result.direct).toHaveLength(0);
    expect(result.hints[0]).toContain('/repo/data/report.xlsx');
    expect(fetchCalls.filter((c) => c.url.includes('/api/fs/write'))).toHaveLength(0);
  });
});
