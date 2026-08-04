/**
 * Ambiguous transport failures.
 *
 * When a request dies after it was already handed to the transport, the client
 * knows the response was lost — it does NOT know whether the server processed
 * the request. Over the relay tunnel this is the common case: a reconnect, a
 * host-side stream abort, or a dead channel all fail an in-flight POST that may
 * already be running server-side.
 *
 * Callers must be able to tell that state apart from a definite failure, and
 * string-matching the message text is not a contract — a renamed abort reason
 * silently reclassifies a send. Transports therefore tag these errors, and
 * callers read the tag (see `isAmbiguousTransportFailure`).
 *
 * `prompt_async` is the motivating case: treating an ambiguous failure as a
 * definite one rolls back the user message and lets the queue re-send a prompt
 * the engine is already answering, producing two independent AI responses.
 */

const AMBIGUOUS_TRANSPORT_FLAG = '__openchamberAmbiguousTransport';

/**
 * Mark an error as "dispatched, outcome unknown". Returns the same error so it
 * can be thrown inline.
 */
export const markAmbiguousTransportFailure = <T extends Error>(error: T): T => {
  Object.defineProperty(error, AMBIGUOUS_TRANSPORT_FLAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
};

/**
 * True when a transport tagged this error as dispatched-but-unconfirmed.
 * Deliberately tag-only: text heuristics belong to the caller that owns them.
 */
export const isAmbiguousTransportFailure = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return (error as Record<string, unknown>)[AMBIGUOUS_TRANSPORT_FLAG] === true;
};
