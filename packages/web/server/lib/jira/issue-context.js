const MAX_DESCRIPTION_CHARS = 6_000;
const MAX_COMMENT_CHARS = 1_200;
const MAX_COMMENTS = 5;
const MAX_TITLE_CHARS = 120;

const clip = (text, max) => {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… (truncated)`;
};

/**
 * Flatten an Atlassian Document Format node tree to plain text. REST API v2
 * normally returns plain strings, but ADF payloads must never leak
 * "[object Object]" into a session prompt.
 */
export function adfToPlainText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join('');
  if (typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  const content = Array.isArray(node.content) ? node.content : [];
  const inner = content.map(adfToPlainText).join('');
  const blockTypes = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'rule']);
  return blockTypes.has(node.type) ? `${inner}\n` : inner;
}

const fieldText = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return adfToPlainText(value).trim();
  return '';
};

const namedField = (value) => {
  if (!value || typeof value !== 'object') return null;
  return typeof value.name === 'string' && value.name ? value.name : null;
};

const personField = (value) => {
  if (!value || typeof value !== 'object') return null;
  return typeof value.displayName === 'string' && value.displayName ? value.displayName : null;
};

const linkedIssueLines = (issuelinks) => {
  if (!Array.isArray(issuelinks)) return [];
  const lines = [];
  for (const link of issuelinks) {
    const outward = link?.outwardIssue;
    const inward = link?.inwardIssue;
    if (outward?.key) {
      const relation = link?.type?.outward || 'relates to';
      lines.push(`- ${relation} ${outward.key}: ${outward.fields?.summary || ''}`.trimEnd());
    } else if (inward?.key) {
      const relation = link?.type?.inward || 'relates to';
      lines.push(`- ${relation} ${inward.key}: ${inward.fields?.summary || ''}`.trimEnd());
    }
  }
  return lines;
};

const commentLines = (comment) => {
  const all = Array.isArray(comment?.comments) ? comment.comments : [];
  const recent = all.slice(-MAX_COMMENTS);
  const lines = [];
  for (const entry of recent) {
    const author = personField(entry?.author) || 'Unknown';
    const created = typeof entry?.created === 'string' ? entry.created : '';
    const body = clip(fieldText(entry?.body), MAX_COMMENT_CHARS);
    if (!body) continue;
    lines.push(`**${author}**${created ? ` (${created})` : ''}:`, body, '');
  }
  return { lines, total: all.length, shown: recent.length };
};

export function buildJiraIssueUrl(baseUrl, issueKey) {
  return `${baseUrl}/browse/${encodeURIComponent(issueKey)}`;
}

/**
 * Build the session title for an issue: "KEY: summary" bounded to a sane length.
 */
export function buildJiraSessionTitle(issue) {
  const key = typeof issue?.key === 'string' ? issue.key : 'Jira issue';
  const summary = typeof issue?.fields?.summary === 'string' ? issue.fields.summary.trim() : '';
  const title = summary ? `${key}: ${summary}` : key;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/**
 * Turn a Jira issue payload (REST API v2 `GET /issue` with the fields the
 * client requests) into the initial session prompt.
 */
export function buildJiraIssuePrompt({ issue, baseUrl }) {
  const fields = issue?.fields && typeof issue.fields === 'object' ? issue.fields : {};
  const key = typeof issue?.key === 'string' ? issue.key : '';
  const url = key && baseUrl ? buildJiraIssueUrl(baseUrl, key) : null;

  const meta = [];
  const type = namedField(fields.issuetype);
  const status = namedField(fields.status);
  const priority = namedField(fields.priority);
  const reporter = personField(fields.reporter);
  const assignee = personField(fields.assignee);
  const project = fields.project && typeof fields.project === 'object'
    ? [fields.project.key, fields.project.name].filter(Boolean).join(' — ')
    : null;
  if (type) meta.push(`- Type: ${type}`);
  if (status) meta.push(`- Status: ${status}`);
  if (priority) meta.push(`- Priority: ${priority}`);
  if (project) meta.push(`- Project: ${project}`);
  if (reporter) meta.push(`- Reporter: ${reporter}`);
  if (assignee) meta.push(`- Assignee: ${assignee}`);
  if (Array.isArray(fields.labels) && fields.labels.length > 0) {
    meta.push(`- Labels: ${fields.labels.filter((l) => typeof l === 'string').join(', ')}`);
  }
  if (Array.isArray(fields.components) && fields.components.length > 0) {
    const names = fields.components.map(namedField).filter(Boolean);
    if (names.length > 0) meta.push(`- Components: ${names.join(', ')}`);
  }
  if (fields.parent?.key) {
    meta.push(`- Parent: ${fields.parent.key}${fields.parent.fields?.summary ? ` — ${fields.parent.fields.summary}` : ''}`);
  }

  const lines = [
    `Work on the following Jira issue.`,
    '',
    `# ${key}: ${typeof fields.summary === 'string' ? fields.summary : ''}`.trimEnd(),
  ];
  if (url) lines.push('', `Issue link: ${url}`);
  if (meta.length > 0) lines.push('', ...meta);

  const description = clip(fieldText(fields.description), MAX_DESCRIPTION_CHARS);
  lines.push('', '## Description', '', description || '_No description provided._');

  const links = linkedIssueLines(fields.issuelinks);
  if (links.length > 0) {
    lines.push('', '## Linked issues', '', ...links);
  }

  const comments = commentLines(fields.comment);
  if (comments.lines.length > 0) {
    const heading = comments.total > comments.shown
      ? `## Recent comments (${comments.shown} of ${comments.total})`
      : '## Comments';
    lines.push('', heading, '', ...comments.lines);
  }

  lines.push(
    '',
    '## Instructions',
    '',
    'Implement what this issue asks for in the current project. '
      + 'If the issue is ambiguous or lacks required details, state exactly what is missing instead of guessing.',
  );

  return lines.join('\n').trim();
}
