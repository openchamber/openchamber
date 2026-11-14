import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { SHARE_DOCUMENT_MESSAGES_PATH, collectShareDocumentMessages, renderShareDocumentMessagesModule } from './messages';

describe('the strings a shared page carries', () => {
  test('match what its components name (run share-document:generate after changing them)', async () => {
    expect(readFileSync(SHARE_DOCUMENT_MESSAGES_PATH, 'utf8')).toBe(renderShareDocumentMessagesModule(await collectShareDocumentMessages()));
  });

  test('include the form controls the chat adds to a page', async () => {
    const messages = new Map(await collectShareDocumentMessages());
    expect(messages.get('uk')?.['chat.uiBlock.send']).toBe('Надіслати');
    expect(messages.get('en')?.['chat.uiBlock.note.add']).toBe('Add a note');
  });
});
