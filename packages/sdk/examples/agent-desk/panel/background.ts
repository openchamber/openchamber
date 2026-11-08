// Actions run here, in a hidden frame: each one files its target with the service.
import { connectHost } from '@openchamber/sdk';

const host = connectHost();
host.onAction(async (item) => {
  await host.serviceRequest({ method: 'POST', path: '/note', body: JSON.stringify({ note: JSON.stringify(item) }) });
});
