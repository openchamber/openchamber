import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
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
