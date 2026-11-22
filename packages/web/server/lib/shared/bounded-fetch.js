// A fetch with a real per-attempt deadline (design #802 phase 1, #803).
//
// The anti-pattern this retires is gitlab/network.js's fetchWithTimeout:
// it overwrites init.signal with its own controller (discarding the
// caller's cancellation) and clears its timer as soon as the fetch promise
// settles, which is when the response HEADERS arrive — so a stalled body
// read is unbounded. Here the caller's signal is composed with the
// deadline, never replaced, and by default the deadline stays armed until
// the response body has been fully read; a headers-only bound is an
// explicit opt-in (headersOnly: true).

// Compose signals so any one of them aborts the result, mirroring
// AbortSignal.any where the runtime has it and composing manually where
// it does not (the oldest supported hosts lack AbortSignal.any). The
// returned detach removes the forwarding listeners once settled.
export const combineAbortSignals = (signals) => {
  const anyImpl = AbortSignal.any;
  if (anyImpl) {
    return { signal: anyImpl(signals), detach: () => {} };
  }
  const controller = new AbortController();
  const forwarders = signals.map((signal) => () => controller.abort(signal.reason));
  signals.forEach((signal, index) => {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', forwarders[index], { once: true });
    }
  });
  return {
    signal: controller.signal,
    detach: () => {
      signals.forEach((signal, index) => signal.removeEventListener('abort', forwarders[index]));
    },
  };
};

// Wrap the response so the deadline keeps bounding the body read: the
// underlying reader is raced against the composed signal, so the read
// settles at the deadline even if the fetch implementation would let a
// silent body stream hang forever. Status and headers are preserved.
const boundResponseBody = (response, signal, cleanup) => {
  const reader = response.body.getReader();
  let settled = false;
  const settle = () => {
    if (!settled) {
      settled = true;
      cleanup();
    }
  };
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    } else {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }
  });
  // The race below observes this promise; this catch only keeps a late
  // abort (after the body already settled) from surfacing as unhandled.
  aborted.catch(() => {});
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        settle();
        controller.error(error);
        // Cancellation is best-effort cleanup only, never awaited before
        // erroring: a pending cancel (e.g. the other branch of a cloned
        // response still unread) would otherwise hold the error hostage
        // and defeat the body deadline this wrapper exists to enforce.
        reader.cancel().catch(() => {});
      }
    },
    cancel() {
      settle();
      // Same rule as the error path: never let a pending underlying
      // cancellation hold the wrapped stream's consumer hostage.
      reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs: number, signal?: AbortSignal, headersOnly?: boolean }} options
 *   timeoutMs is required and must be positive. The deadline composes with
 *   the caller's signal (options.signal wins over init.signal is NOT a
 *   thing: pass the caller signal in options). By default the deadline
 *   covers the body read; headersOnly: true clears it when headers arrive.
 * @returns {Promise<Response>}
 */
export const fetchWithDeadline = async (fetchImpl, url, init = {}, options = {}) => {
  const { timeoutMs, signal: callerSignal, headersOnly = false } = options ?? {};
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('fetchWithDeadline requires a positive timeoutMs');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  const sources = callerSignal ? [callerSignal, deadline.signal] : [deadline.signal];
  const { signal, detach } = combineAbortSignals(sources);
  const cleanup = () => {
    clearTimeout(timer);
    detach();
  };

  let response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    cleanup();
    throw error;
  }

  if (headersOnly || !response?.body) {
    cleanup();
    return response;
  }
  return boundResponseBody(response, signal, cleanup);
};
