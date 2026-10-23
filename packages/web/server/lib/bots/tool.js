export const BOT_TOOL_ACTIONS = [
  { action: 'item.report', title: 'Report bot evidence', description: 'Attach evidence to this item. Mark critical only for an incident or security issue that needs immediate attention.' },
  { action: 'item.ask', title: 'Ask about the bot item', description: 'Ask a person a question and wait. Supply a stable operationId and reuse it for retries. People are IDs from the approved project directory; requestedRole is an optional role from that directory.' },
  { action: 'git.push', title: 'Publish bot commits', description: 'Publish the owned item branch using the bot identity. The server chooses the repository, branch and commits.' },
  { action: 'pr.open', title: 'Open the bot pull request', description: 'Open the item pull request after server judgment. The server supplies evidence, proof and destination.' },
  { action: 'pr.comment', title: 'Comment on the bot pull request', description: 'Comment on this item pull request using the bot identity.' },
  { action: 'jira.comment', title: 'Comment on the bot Jira issue', description: 'Comment on this item Jira issue using the bot identity.' },
  { action: 'jira.transition', title: 'Transition the bot Jira issue', description: 'Apply the configured done transition after the item pull request merged.' },
  { action: 'discord.send', title: 'Send a bot Discord message', description: 'Send a message to this item configured Discord destination using the bot app.' },
];

export const BOT_TOOL_PARAMETERS = {
  operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$', description: 'Stable ID for this logical write. Keep the same ID after an uncertain result; never invent another ID to retry it.' },
  body: { type: 'string', description: 'Message text for a comment or Discord send.' },
  question: { type: 'string', description: 'The question for item.ask.' },
  people: { type: 'array', items: { type: 'string' }, description: 'Approved person IDs for item.ask.' },
  requestedRole: { type: 'string', minLength: 1, maxLength: 200, description: 'Project people-directory role for item.ask when area owners are unavailable.' },
  critical: { type: 'boolean', description: 'Whether reported evidence needs an immediate incident alert.' },
  evidence: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, summary: { type: 'string' }, url: { type: 'string' } }, required: ['source', 'summary'], additionalProperties: false } },
};
