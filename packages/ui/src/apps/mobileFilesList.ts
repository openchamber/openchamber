export type MobileFilesRoute =
  | { type: 'browser'; directory: string }
  | { type: 'file'; path: string; returnDirectory: string };

export type MobileFilesListedFor = { directory: string; query: string };

type MobileFilesListMemory = { key: string | null; ready: boolean; searchLoading: boolean };

export const mobileFilesList = ({ runtimeKey, route, query, entriesDirectory, directoryError, searchResultsFor, isSearching }: {
  runtimeKey: string;
  route: MobileFilesRoute;
  query: string;
  entriesDirectory: string | null;
  directoryError: string | null;
  searchResultsFor: MobileFilesListedFor | null;
  isSearching: boolean;
}): MobileFilesListMemory => {
  if (route.type !== 'browser') return { key: null, ready: false, searchLoading: false };
  const searchQuery = query.trim();
  if (!searchQuery) {
    return {
      key: `dir:${runtimeKey}:${route.directory}`,
      ready: entriesDirectory === route.directory && !directoryError,
      searchLoading: false,
    };
  }
  const ownResults = searchResultsFor?.directory === route.directory && searchResultsFor.query === searchQuery;
  return {
    key: `search:${runtimeKey}:${route.directory}:${searchQuery}`,
    ready: ownResults && !directoryError,
    searchLoading: isSearching && !ownResults,
  };
};
