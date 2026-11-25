import React from "react";

const readers = new Map<string, number>();

export const catalogReaderDirectories = (): string[] => [...readers.keys()];

export function registerCatalogReader(directory: string): () => void {
  readers.set(directory, (readers.get(directory) ?? 0) + 1);
  return () => {
    const remaining = (readers.get(directory) ?? 1) - 1;
    if (remaining > 0) readers.set(directory, remaining);
    else readers.delete(directory);
  };
}

export function useCatalogReader(directory: string | null | undefined): void {
  React.useEffect(() => (directory ? registerCatalogReader(directory) : undefined), [directory]);
}
