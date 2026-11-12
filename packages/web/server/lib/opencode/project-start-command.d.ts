/** Where the start command comes from: the running OpenCode in production, a fixture in tests. */
export type ProjectStartCommandSource = {
  read: (directory: string) => Promise<string>;
};

export function configureProjectStartCommandSource(next: ProjectStartCommandSource | null): void;
export function openCodeProjectStartCommandSource(connection: {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
}): ProjectStartCommandSource;
export function readProjectStartCommand(directory: string): Promise<string>;
