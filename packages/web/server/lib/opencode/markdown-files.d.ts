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
