export async function stopEmbeddedServer(handle, { launchFallback, warn, timeoutMs = 35_000 }) {
  if (!handle) return;
  let timer;
  try {
    await Promise.race([
      handle.stop({ exitProcess: false }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Embedded server shutdown timed out')), timeoutMs);
      }),
    ]);
  } catch (error) {
    warn(error);
    launchFallback(handle.getOpenCodeProcessInfo?.());
  } finally {
    clearTimeout(timer);
  }
}
