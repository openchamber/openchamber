import { handleDocumentCall } from './documentHost';
import type { DocumentRequest, DocumentResponse } from './documentProtocol';

const post = (message: DocumentResponse) => self.postMessage(message);

self.addEventListener('message', (event: MessageEvent<DocumentRequest>) => {
  const { id, op, args } = event.data;
  // SAFETY: the client typed this request by its op.
  void handleDocumentCall(op, args as never, (value) => post({ id, type: 'chunk', value }))
    .then((value) => post({ id, type: 'done', value }))
    .catch((error: Error) => post({ id, type: 'error', message: error.message }));
});
