import { writeFileSync } from 'node:fs';
import { SHARE_DOCUMENT_MESSAGES_PATH, collectShareDocumentMessages, renderShareDocumentMessagesModule } from './messages';

writeFileSync(SHARE_DOCUMENT_MESSAGES_PATH, renderShareDocumentMessagesModule(await collectShareDocumentMessages()));
