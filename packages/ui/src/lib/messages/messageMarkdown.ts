import type { Part } from '@opencode-ai/sdk/v2';
import { readContextPart, type ContextPartPayload } from './contextParts';
import { extractTerminalContexts } from './terminalContext';

/** Preserve both the source and the reply when a model context needs a limit. */
export function excerptMarkdown(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n\n[Content omitted]\n\n';
  const head = Math.ceil((limit - marker.length) / 2);
  const tail = Math.floor((limit - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-tail);
}

function quoteContext(source: string, body: string, comment: string, fieldLimit?: number, codeLanguage?: string): string {
  const excerpt = (text: string) => fieldLimit ? excerptMarkdown(text, fieldLimit) : text;
  let content = excerpt(body);
  if (codeLanguage !== undefined) {
    let fenceLength = 3;
    for (const match of content.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    content = `${fence}${codeLanguage.replace(/[^\w+#.-]/g, '')}\n${content}\n${fence}`;
  }
  const quote = content.split('\n').map((line) => `> ${line}`).join('\n');
  return `${source}\n\n${quote}${comment.trim() ? `\n\n**User comment:**\n\n${excerpt(comment)}` : ''}`;
}

function formatContext(payload: ContextPartPayload, originalText: string, fieldLimit?: number): string {
  switch (payload.kind) {
    case 'code-comment':
      return quoteContext(
        `Quoted from \`${payload.fileLabel}\`, lines ${payload.startLine}-${payload.endLine}${payload.side ? `, ${payload.side}` : ''}:`,
        payload.code, payload.text, fieldLimit, payload.language,
      );
    case 'file-quote':
      return quoteContext(
        `Quoted from \`${payload.fileLabel}\`${payload.startLine != null ? `, lines ${payload.startLine}-${payload.endLine ?? payload.startLine}` : ''}:`,
        payload.quote, payload.text, fieldLimit,
      );
    case 'chat-quote':
      return quoteContext('Quoted from an earlier message:', payload.quote, payload.text, fieldLimit);
    case 'browser-annotation':
      return quoteContext(`Browser annotation on ${payload.pageUrl}:`, payload.prompt, payload.text, fieldLimit);
    case 'pr-comment':
      return quoteContext(`GitHub PR comment, ${payload.label}:`, payload.body, payload.text, fieldLimit);
    case 'pr-check':
      return quoteContext(`GitHub PR check, ${payload.label}:`, payload.output, payload.text, fieldLimit, '');
    case 'terminal':
      return quoteContext(`Terminal ${payload.terminalLabel}, lines ${payload.startLine}-${payload.endLine}:`, payload.output, '', fieldLimit, '');
    case 'github-issue':
    case 'github-pr':
    case 'linear-issue':
    case 'guest-issue':
    case 'guest-pr':
      return fieldLimit ? excerptMarkdown(originalText, fieldLimit) : originalText;
  }
}

/** User-attached synthetic parts are content; other synthetic prompts are optional. */
export function formatMessageText(
  parts: readonly Part[],
  options: { user?: boolean; excludeSynthetic?: boolean; fieldLimit?: number } = {},
): string {
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text' || (options.excludeSynthetic && part.ignored)) continue;
    const context = options.user ? readContextPart(part) : null;
    if (context) {
      blocks.push(formatContext(context, part.text, options.fieldLimit));
      continue;
    }
    if (options.excludeSynthetic && part.synthetic) continue;
    if (!options.user) {
      blocks.push(options.fieldLimit ? excerptMarkdown(part.text, options.fieldLimit) : part.text);
      continue;
    }
    const terminal = extractTerminalContexts(part.text);
    blocks.push(options.fieldLimit ? excerptMarkdown(terminal.visibleText, options.fieldLimit) : terminal.visibleText);
    for (const item of terminal.contexts) {
      blocks.push(quoteContext(`Terminal ${item.terminalLabel}, lines ${item.startLine}-${item.endLine}:`, item.text, '', options.fieldLimit, ''));
    }
  }
  return blocks.map((block) => block.trim()).filter(Boolean).join('\n\n');
}
