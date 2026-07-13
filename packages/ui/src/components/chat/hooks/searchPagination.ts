export type SearchPaginationDecision = 'wait' | 'start';

export const getSearchPaginationDecision = ({
  inFlightKey,
  retryVersion,
  settledVersion,
  historyLoading,
}: {
  inFlightKey: string | null;
  retryVersion: number;
  settledVersion: number;
  historyLoading: boolean;
}): SearchPaginationDecision => {
  // A settled request increments both versions. The equality is the stable
  // state in which the current key may start the next page; an in-flight
  // request always wins until its finally block clears the ref.
  if (historyLoading || inFlightKey !== null) {
    return 'wait';
  }
  if (retryVersion !== settledVersion) {
    return 'wait';
  }
  return 'start';
};
