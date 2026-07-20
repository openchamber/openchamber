import { getDiff, getStatus } from '../git/service.js';
import { clipBlock, escapeMd } from './messenger-render.js';

const DIFF_PREVIEW_LIMIT = 1500;
const FILE_LIST_LIMIT = 12;

function sumDiffStats(diffStats) {
  let insertions = 0;
  let deletions = 0;
  for (const stat of Object.values(diffStats ?? {})) {
    insertions += Number(stat?.insertions ?? 0);
    deletions += Number(stat?.deletions ?? 0);
  }
  return { insertions, deletions };
}

function formatFileStatus(file) {
  const status = `${file?.index ?? ''}${file?.working_dir ?? ''}`.trim() || '?';
  const filePath = file?.path ?? file?.from ?? '';
  return filePath ? `\`${escapeMd(filePath)}\` ${status}` : null;
}

function buildDiffPreview({ stagedDiff, unstagedDiff }) {
  const sections = [];
  if (stagedDiff.trim()) sections.push(`--- staged ---\n${stagedDiff.trim()}`);
  if (unstagedDiff.trim()) sections.push(`--- unstaged ---\n${unstagedDiff.trim()}`);
  const combined = sections.join('\n\n');
  if (!combined.trim()) return { preview: '', truncated: false };
  const clipped = clipBlock(combined.replace(/```/g, "'''"), DIFF_PREVIEW_LIMIT);
  return { preview: clipped, truncated: clipped.length < combined.length };
}

export async function buildMessengerGitDiffReply({
  projectPath,
  getStatusFn = getStatus,
  getDiffFn = getDiff,
} = {}) {
  if (!projectPath) return { ok: false, error: 'no project bound to this conversation.' };

  const status = await getStatusFn(projectPath);
  const files = Array.isArray(status?.files) ? status.files : [];
  const { insertions, deletions } = sumDiffStats(status?.diffStats);

  const [stagedDiff, unstagedDiff] = await Promise.all([
    getDiffFn(projectPath, { staged: true, contextLines: 3 }).catch(() => ''),
    getDiffFn(projectPath, { contextLines: 3 }).catch(() => ''),
  ]);
  const { preview, truncated } = buildDiffPreview({ stagedDiff, unstagedDiff });

  if ((status?.isClean || files.length === 0) && !preview) {
    return {
      ok: true,
      reply: [
        '**Git diff**',
        `Project: \`${escapeMd(projectPath)}\``,
        '',
        '_Working tree is clean._',
      ].join('\n'),
    };
  }

  const lines = [
    '**Git diff**',
    `Project: \`${escapeMd(projectPath)}\``,
    `Files changed: ${files.length}${insertions || deletions ? ` · +${insertions} / -${deletions}` : ''}`,
  ];
  const fileLines = files.map(formatFileStatus).filter(Boolean).slice(0, FILE_LIST_LIMIT);
  if (fileLines.length > 0) {
    lines.push('', fileLines.join('\n'));
    if (files.length > FILE_LIST_LIMIT) {
      lines.push(`_...and ${files.length - FILE_LIST_LIMIT} more file${files.length - FILE_LIST_LIMIT === 1 ? '' : 's'}._`);
    }
  }
  if (preview) {
    lines.push('', '```diff', preview, '```');
  } else {
    lines.push('', '_No tracked diff preview is available. Untracked files are listed above._');
  }
  if (truncated) {
    lines.push('_Diff preview truncated. Run `/shell git diff --stat && git diff` for the full output._');
  }
  return { ok: true, reply: lines.join('\n') };
}
