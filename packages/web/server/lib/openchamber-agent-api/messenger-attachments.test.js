import { describe, it, expect, vi } from 'vitest';
import {
  classifyAttachment,
  renderTextAttachmentBlock,
  renderFailedAttachmentBlock,
  processDiscordAttachments,
  composePromptText,
  resolveDiscordMentions,
} from './messenger-attachments.js';

const okResponse = (bytes) => ({
  ok: true,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
});

describe('classifyAttachment', () => {
  it('classifies by mime type', () => {
    expect(classifyAttachment({ content_type: 'text/plain' })).toBe('text');
    expect(classifyAttachment({ content_type: 'application/json' })).toBe('text');
    expect(classifyAttachment({ content_type: 'image/png' })).toBe('image');
    expect(classifyAttachment({ content_type: 'application/pdf' })).toBe('pdf');
    expect(classifyAttachment({ content_type: 'audio/ogg; codecs=opus' })).toBe('audio');
    expect(classifyAttachment({ content_type: 'application/zip' })).toBe('unknown');
  });
  it('falls back to the file extension when mime is missing', () => {
    expect(classifyAttachment({ filename: 'notes.md' })).toBe('text');
    expect(classifyAttachment({ filename: 'script.ts' })).toBe('text');
    expect(classifyAttachment({ filename: 'data.bin' })).toBe('unknown');
  });
});

describe('attachment rendering', () => {
  it('wraps text content in an inline XML block', () => {
    const block = renderTextAttachmentBlock({ filename: 'a.log', mime: 'text/plain', content: 'boom' });
    expect(block).toBe('<attachment filename="a.log" mime="text/plain">\nboom\n</attachment>');
  });
  it('renders failures as a self-closing stub', () => {
    expect(renderFailedAttachmentBlock({ filename: 'x.json', error: 'Failed to fetch: 404' }))
      .toBe('<attachment filename="x.json" error="Failed to fetch: 404" />');
  });
});

describe('processDiscordAttachments', () => {
  it('inlines text files and converts images to data-url file parts', async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.includes('log') ? okResponse([104, 105]) : okResponse([1, 2, 3]),
    );
    const result = await processDiscordAttachments({
      attachments: [
        { filename: 'err.log', content_type: 'text/plain', url: 'https://cdn/log', size: 2 },
        { filename: 'shot.png', content_type: 'image/png', url: 'https://cdn/png', size: 3 },
      ],
      fetchImpl,
    });
    expect(result.textBlocks).toHaveLength(1);
    expect(result.textBlocks[0]).toContain('filename="err.log"');
    expect(result.textBlocks[0]).toContain('hi');
    expect(result.fileParts).toHaveLength(1);
    expect(result.fileParts[0]).toMatchObject({ type: 'file', mime: 'image/png', filename: 'shot.png' });
    expect(result.fileParts[0].url).toMatch(/^data:image\/png;base64,/);
  });

  it('records failed downloads as error stubs', async () => {
    const result = await processDiscordAttachments({
      attachments: [{ filename: 'x.json', content_type: 'application/json', url: 'https://cdn/x', size: 1 }],
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    expect(result.textBlocks[0]).toContain('error="Failed to fetch: 404"');
  });

  it('rejects oversized attachments without downloading', async () => {
    const fetchImpl = vi.fn();
    const result = await processDiscordAttachments({
      attachments: [{ filename: 'big.txt', content_type: 'text/plain', url: 'https://cdn/big', size: 99 * 1024 * 1024 }],
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.textBlocks[0]).toContain('too large');
  });

  it('transcribes audio when a transcriber is provided', async () => {
    const result = await processDiscordAttachments({
      attachments: [{ filename: 'voice.ogg', content_type: 'audio/ogg', url: 'https://cdn/v', size: 4 }],
      fetchImpl: async () => okResponse([0, 1, 2, 3]),
      transcribe: async () => ' add a login page ',
    });
    expect(result.transcripts).toEqual(['add a login page']);
    expect(result.notes).toHaveLength(0);
  });

  it('hints at STT configuration when no transcriber is available', async () => {
    const result = await processDiscordAttachments({
      attachments: [{ filename: 'voice.ogg', content_type: 'audio/ogg', url: 'https://cdn/v', size: 4 }],
      fetchImpl: async () => okResponse([0, 1, 2, 3]),
      transcribe: null,
    });
    expect(result.transcripts).toHaveLength(0);
    expect(result.notes[0]).toContain('speech-to-text is not configured');
  });

  it('skips unsupported attachment types with a note', async () => {
    const result = await processDiscordAttachments({
      attachments: [{ filename: 'x.zip', content_type: 'application/zip', url: 'https://cdn/z', size: 4 }],
      fetchImpl: vi.fn(),
    });
    expect(result.notes[0]).toContain('unsupported type');
  });
});

describe('composePromptText', () => {
  it('appends text blocks after the body', () => {
    const out = composePromptText({ body: 'look at this', textBlocks: ['<attachment filename="a" mime="b">\nx\n</attachment>'], transcripts: [] });
    expect(out.startsWith('look at this')).toBe(true);
    expect(out).toContain('<attachment');
  });
  it('unwraps a single text attachment when the body is empty (send-as-file)', () => {
    const out = composePromptText({
      body: '',
      textBlocks: ['<attachment filename="prompt.txt" mime="text/plain">\nlong prompt here\n</attachment>'],
      transcripts: [],
    });
    expect(out).toBe('long prompt here');
  });
  it('uses voice transcripts as the prompt for voice-only messages', () => {
    const out = composePromptText({ body: '', textBlocks: [], transcripts: ['fix the build'] });
    expect(out).toBe('fix the build');
  });
});

describe('resolveDiscordMentions', () => {
  it('resolves user mentions from the gateway payload', async () => {
    const out = await resolveDiscordMentions({
      text: 'hey <@111> and <@!222>',
      message: { mentions: [{ id: '111', username: 'alice' }, { id: '222', global_name: 'Bob' }] },
    });
    expect(out).toBe('hey @alice and @Bob');
  });
  it('resolves role and channel mentions via lookups', async () => {
    const out = await resolveDiscordMentions({
      text: 'ping <@&333> in <#444>',
      message: { mentions: [] },
      lookupRole: async (id) => (id === '333' ? 'devs' : null),
      lookupChannel: async (id) => (id === '444' ? 'general' : null),
    });
    expect(out).toBe('ping @devs in #general');
  });
  it('leaves unresolvable mentions untouched', async () => {
    const out = await resolveDiscordMentions({ text: 'see <@999>', message: { mentions: [] } });
    expect(out).toBe('see <@999>');
  });
});
