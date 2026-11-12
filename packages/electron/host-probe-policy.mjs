export const FAST_HOST_PROBE_TIMEOUT_MS = 2_000;
export const RETRY_HOST_PROBE_TIMEOUT_MS = 10_000;

export const probeDirectHostWithRetry = async (probe) => {
  const fastResult = await probe(FAST_HOST_PROBE_TIMEOUT_MS);
  if (fastResult.status !== 'unreachable') {
    return fastResult;
  }
  return probe(RETRY_HOST_PROBE_TIMEOUT_MS);
};
