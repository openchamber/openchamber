import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { appendTerminalContexts } from './terminalContext';
import { formatCommentNote } from './commentNote';

export type InlineCommentPartPayload = {
  text: string
  synthetic: true
  metadata?: {
    opencodeComment: {
      path: string
      selection: { startLine: number; endLine: number; startChar: number; endChar: number }
      comment: string
      preview: string
      origin: 'file' | 'review'
    }
  }
}

/**
 * Format a single inline comment draft into the standard message format
 * used by diff, plan, and file viewers
 */
function formatInlineCommentDraft(draft: InlineCommentDraft): string {
  const { fileLabel, startLine, endLine, side, language, code, text } = draft;

  // Diff format includes side (original/modified)
  if (draft.source === 'diff' && side) {
    return `Comment on \`${fileLabel}\` lines ${startLine}-${endLine} (${side}):\n\`\`\`${language}\n${code}\n\`\`\`\n\n${text}`;
  }

  if (draft.source === 'preview-console') {
    return `Attached preview context from \`${fileLabel}\`:\n\`\`\`${language}\n${code}\n\`\`\`\n\n${text}`;
  }

  if (draft.source === 'preview-annotation') {
    return text ? `${code}\n\n${text}` : code;
  }

  // Plan and file format (no side)
  return `Comment on \`${fileLabel}\` lines ${startLine}-${endLine}:\n\`\`\`${language}\n${code}\n\`\`\`\n\n${text}`;
}

/**
 * Format multiple inline comment drafts into a single string
 * with each comment separated by a blank line
 */
function formatInlineCommentDrafts(drafts: InlineCommentDraft[]): string {
  if (drafts.length === 0) return '';

  if (drafts.every((draft) => draft.source === 'preview-annotation')) {
    return drafts.map(formatInlineCommentDraft).join('\n\n---\n\n');
  }

  return drafts.map(formatInlineCommentDraft).join('\n\n');
}

/**
 * Convert inline comment drafts to synthetic message parts.
 *
 * Real inline comments (file/diff/plan) are emitted in OpenCode Desktop's text
 * format with `opencodeComment` metadata, so both apps render them as comment
 * cards. Preview-context drafts (dev server console/annotations) are a different
 * feature and are emitted as plain synthetic context, without comment metadata.
 */
export function buildInlineCommentParts(drafts: InlineCommentDraft[]): InlineCommentPartPayload[] {
  return drafts.map(draft => {
    if (draft.source === 'preview-console' || draft.source === 'preview-annotation') {
      return { text: formatInlineCommentDraft(draft), synthetic: true as const };
    }

    const path = draft.fileLabel.replace(/:\d+(-\d+)?$/, '');
    return {
      text: formatCommentNote({
        path,
        startLine: draft.startLine,
        endLine: draft.endLine,
        comment: draft.text,
      }),
      synthetic: true as const,
      metadata: {
        opencodeComment: {
          path,
          selection: {
            startLine: draft.startLine,
            endLine: draft.endLine,
            startChar: 0,
            endChar: 0,
          },
          comment: draft.text,
          preview: draft.code,
          origin: (draft.source === 'diff' ? 'review' : 'file') as 'file' | 'review',
        },
      },
    };
  });
}

/**
 * Append inline comment drafts to an existing message text.
 *
 * Kept for the `terminal` comment source, which serializes terminal output as
 * message text (not as an `opencodeComment` card). Code/preview comments go
 * through `buildInlineCommentParts` instead.
 * If the text is empty, returns just the formatted comments; otherwise appends
 * comments after a blank line separator.
 */
export function appendInlineComments(text: string, drafts: InlineCommentDraft[]): string {
  if (drafts.length === 0) return text;
  const terminalDrafts = drafts.filter((draft) => draft.source === 'terminal');
  const otherDrafts = drafts.filter((draft) => draft.source !== 'terminal');
  const withComments = otherDrafts.length > 0
    ? (text.trim() ? `${text}\n\n${formatInlineCommentDrafts(otherDrafts)}` : formatInlineCommentDrafts(otherDrafts))
    : text;
  if (terminalDrafts.length > 0) {
    return appendTerminalContexts(withComments, terminalDrafts.map((draft) => ({
      terminalId: draft.language,
      terminalLabel: draft.fileLabel,
      startLine: draft.startLine,
      endLine: draft.endLine,
      text: draft.code,
    })));
  }
  return withComments;
}
