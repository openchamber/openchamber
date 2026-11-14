import { writeFileSync } from 'node:fs';
import { SHARE_DOCUMENT_MESSAGES_PATH, collectShareDocumentMessages, renderShareDocumentMessagesModule } from './messages';

// Run after changing strings the UI block renderer shows: `bun run --cwd packages/ui share-document:generate`.
writeFileSync(SHARE_DOCUMENT_MESSAGES_PATH, renderShareDocumentMessagesModule(await collectShareDocumentMessages()));
