export const createRequestAbortSignal = (req, res) => {
  const controller = new AbortController();
  let clientAborted = false;
  const abort = () => {
    if (!res?.writableEnded) {
      clientAborted = true;
      controller.abort();
    }
  };

  req?.once?.('aborted', abort);
  res?.once?.('close', abort);
  if (req?.aborted) abort();

  return {
    signal: controller.signal,
    get clientAborted() {
      return clientAborted;
    },
    abort: () => controller.abort(),
    cleanup: () => {
      req?.off?.('aborted', abort);
      res?.off?.('close', abort);
    },
  };
};

// A request can become unavailable between an owned operation finishing and
// the route trying to send its result. Keep this check beside the abort-signal
// wiring so routes do not each invent a slightly different disconnect guard.
// `abort()` is also used for an internal timeout, which cancels owned work but
// must not suppress the timeout response while the client is still connected.
export const canRespondToRequest = (res, requestOrSignal) => {
  const requestAbort = requestOrSignal?.signal ? requestOrSignal : null;
  const signal = requestAbort?.signal || requestOrSignal;
  const clientAborted = requestAbort
    ? requestAbort.clientAborted
    : signal?.aborted;
  return !clientAborted && !res?.destroyed && !res?.writableEnded;
};
