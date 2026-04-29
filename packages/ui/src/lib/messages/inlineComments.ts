import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

/**
 * Format a single inline comment draft into the standard message format
 * used by diff, plan, and file viewers
 */
export function formatInlineCommentDraft(draft: InlineCommentDraft): string {
  const { fileLabel, startLine, endLine, side, language, code, text } = draft;
  
  // Diff format includes side (original/modified)
  if (draft.source === 'diff' && side) {
    return `Comment on \`${fileLabel}\` lines ${startLine}-${endLine} (${side}):\n\`\`\`${language}\n${code}\n\`\`\`\n\n${text}`;
  }

  if (draft.source === 'preview-console' || draft.source === 'preview-annotation') {
    return `Attached preview context from \`${fileLabel}\`:\n\`\`\`${language}\n${code}\n\`\`\`\n\n${text}`;
  }
  
  // Plan and file format (no side)
  return `Comment on \`${fileLabel}\` lines ${startLine}-${endLine}:\n\`\`\`${language}\n${code}\n\`\`\`\n\n${text}`;
}

/**
 * Format multiple inline comment drafts into a single string
 * with each comment separated by a blank line
 */
export function formatInlineCommentDrafts(drafts: InlineCommentDraft[]): string {
  if (drafts.length === 0) return '';
  
  return drafts.map(formatInlineCommentDraft).join('\n\n');
}

/**
 * Append inline comment drafts to an existing message text
 * If the text is empty, returns just the formatted comments
 * Otherwise, appends comments after a blank line separator
 */
export function appendInlineComments(text: string, drafts: InlineCommentDraft[]): string {
  if (drafts.length === 0) return text;
  
  const formattedComments = formatInlineCommentDrafts(drafts);
  
  if (!text.trim()) {
    return formattedComments;
  }
  
  return `${text}\n\n${formattedComments}`;
}

/**
 * Check if a message text contains inline comments (for validation purposes)
 */
export function hasInlineComments(text: string): boolean {
  return text.includes('Comment on `') && text.includes('```');
}

/**
 * Extract the file label from a draft for display purposes
 */
export function getDraftDisplayLabel(draft: InlineCommentDraft): string {
  return `${draft.fileLabel}:${draft.startLine}-${draft.endLine}`;
}
