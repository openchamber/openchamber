export function readWorktreeDirectorySetting(
  workingDirectory: string,
  primaryWorktree?: string,
): string | null;

export const OPENCODE_CONFIG_DIR: string;
export function getOpenCodeDataDir(env?: NodeJS.ProcessEnv): string;

export interface MarkdownDocument {
  frontmatter: unknown;
  body: string;
}

export function parseMdFile(filePath: string): MarkdownDocument;
export function parseMdFileAsync(filePath: string): Promise<MarkdownDocument>;
export function writeMdFile<Frontmatter extends object>(
  filePath: string,
  frontmatter: Frontmatter,
  body: string,
  options?: { flag?: string },
): void;
export function getAncestors(startDir: string | null | undefined, stopDir?: string | null): string[];
export function findWorktreeRoot(startDir: string | null | undefined): string | null;
