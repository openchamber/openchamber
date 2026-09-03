import { createManagedOpenCodeHandoffV2Store } from './store.js';

const send = (message) => process.send?.(message);

send({ type: 'ready' });
process.once('message', async (message) => {
  if (message?.type !== 'open' || typeof message.rootDir !== 'string') {
    send({ type: 'result', ok: false, message: 'Missing store root' });
    process.disconnect?.();
    return;
  }

  let store;
  try {
    store = createManagedOpenCodeHandoffV2Store({ rootDir: message.rootDir });
    await store.close();
    send({ type: 'result', ok: true });
  } catch (error) {
    send({ type: 'result', ok: false, message: error?.message ?? String(error) });
  } finally {
    await store?.close();
    process.disconnect?.();
  }
});
