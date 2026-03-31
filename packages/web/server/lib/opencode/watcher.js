export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    parseSseDataPayload,
    onPayload,
  } = deps;

  let abortController = null;

  const start = async () => {
    if (abortController) {
      return;
    }

    await waitForOpenCodePort();

    abortController = new AbortController();
    const signal = abortController.signal;

    let attempt = 0;
    const run = async () => {
      while (!signal.aborted) {
        attempt += 1;
        let upstream;
        let reader;
        try {
          const url = buildOpenCodeUrl('/global/event', '');
          upstream = await fetch(url, {
            headers: {
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              ...getOpenCodeAuthHeaders(),
            },
            signal,
          });

          if (!upstream.ok || !upstream.body) {
            throw new Error(`bad status ${upstream.status}`);
          }

          console.log('[PushWatcher] connected');

          const decoder = new TextDecoder();
          reader = upstream.body.getReader();
          let buffer = '';

          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex !== -1) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              separatorIndex = buffer.indexOf('\n\n');
              const payload = parseSseDataPayload(block);
              onPayload(payload);
            }
          }
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          console.warn('[PushWatcher] disconnected', error?.message ?? error);
        } finally {
          try {
            if (reader) {
              await reader.cancel();
              reader.releaseLock();
            } else if (upstream?.body && !upstream.body.locked) {
              await upstream.body.cancel();
            }
          } catch {
          }
        }

        const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    };

    void run();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      abortController.abort();
    } catch {
    }
    abortController = null;
  };

  return {
    start,
    stop,
  };
};
