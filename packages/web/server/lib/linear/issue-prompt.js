const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 12_000;
const MAX_COMMENT_LENGTH = 2_000;
const MAX_COMMENTS = 10;

function clip(text, max) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…(truncated)`;
}

/**
 * Session title shown in the OpenChamber sidebar for an issue-started session.
 */
export function buildIssueSessionTitle(issue) {
  const identifier = typeof issue?.identifier === 'string' ? issue.identifier : '';
  const title = typeof issue?.title === 'string' ? issue.title.trim() : '';
  const combined = [identifier, title].filter(Boolean).join(': ');
  if (!combined) return 'Linear issue';
  return combined.length > MAX_TITLE_LENGTH ? `${combined.slice(0, MAX_TITLE_LENGTH - 1)}…` : combined;
}

/**
 * Build the initial session prompt from a Linear issue. The prompt carries
 * the full issue context (identifier, title, description, metadata, recent
 * comments) so the agent can start working without re-fetching anything.
 */
export function buildIssuePrompt(issue) {
  const identifier = typeof issue?.identifier === 'string' ? issue.identifier : 'unknown';
  const title = typeof issue?.title === 'string' ? issue.title.trim() : '';
  const lines = [
    `You are working on Linear issue ${identifier}${title ? `: ${title}` : ''}.`,
    '',
  ];

  const meta = [];
  if (issue?.team?.name) meta.push(`Team: ${issue.team.name}`);
  if (issue?.state?.name) meta.push(`Status: ${issue.state.name}`);
  if (issue?.priorityLabel) meta.push(`Priority: ${issue.priorityLabel}`);
  if (issue?.assignee?.name) meta.push(`Assignee: ${issue.assignee.name}`);
  const labels = Array.isArray(issue?.labels?.nodes)
    ? issue.labels.nodes.map((node) => node?.name).filter(Boolean)
    : [];
  if (labels.length > 0) meta.push(`Labels: ${labels.join(', ')}`);
  if (issue?.url) meta.push(`Issue URL: ${issue.url}`);
  if (issue?.branchName) meta.push(`Suggested branch name: ${issue.branchName}`);
  if (meta.length > 0) {
    lines.push(...meta, '');
  }

  const description = typeof issue?.description === 'string' ? issue.description.trim() : '';
  lines.push('## Issue description', '');
  lines.push(description ? clip(description, MAX_DESCRIPTION_LENGTH) : '(no description provided)');

  const comments = Array.isArray(issue?.comments?.nodes) ? issue.comments.nodes : [];
  const usable = comments
    .filter((comment) => typeof comment?.body === 'string' && comment.body.trim().length > 0)
    .slice(-MAX_COMMENTS);
  if (usable.length > 0) {
    lines.push('', '## Recent comments', '');
    for (const comment of usable) {
      const author = comment?.user?.name ?? comment?.botActor?.name ?? 'Unknown';
      lines.push(`**${author}**:`, '', clip(comment.body, MAX_COMMENT_LENGTH), '');
    }
  }

  lines.push(
    '',
    '## Instructions',
    '',
    `Work on resolving this issue in the current repository. When you are done, summarize what you changed and anything that still needs human attention.`,
  );

  return lines.join('\n');
}
