export interface MarkdownDocument {
  frontmatter: unknown;
  body: string;
}

export function parseMdFile(filePath: string): MarkdownDocument;
export function parseMdFileAsync(filePath: string): Promise<MarkdownDocument>;
export function isPromptFileReference(value: unknown): value is string;
export function resolvePromptFilePath<Reference>(reference: Reference): string | null;
export function writePromptFile(filePath: string, content: string | null): void;
export function writeMdFile<Frontmatter extends object>(
  filePath: string,
  frontmatter: Frontmatter,
  body: string,
  options?: { flag?: string },
): void;
