export function removeDirectory(
  dir: string,
  options?: {
    rm?: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    warn?: (message: string) => void;
  },
): Promise<void>;

export function removeStaleCatalogFolders(options?: {
  tmpDir?: string;
  now?: number;
  uid?: number;
  rm?: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
}): Promise<void>;
