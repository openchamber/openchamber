export interface Snippet {
  name: string;
  content: string;
  aliases: string[];
  description?: string;
  filePath: string;
  source: 'global' | 'project';
}
