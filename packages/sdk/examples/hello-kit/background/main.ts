import { connectHost } from '@openchamber/sdk';

const host = connectHost();
host.onAction(async (item) => {
  if (item.kind !== 'message' || item.action !== 'message-length') throw new Error('Unknown action.');
  await host.toast({ kind: 'info', message: `Message length: ${item.text.length} characters.`, copy: true, dismiss: true, persistent: true });
});
